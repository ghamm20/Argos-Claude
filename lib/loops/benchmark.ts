// lib/loops/benchmark.ts
//
// Self-Evolving Loop Suite (2026-06-02) — Loop19: the BENCHMARK HARNESS.
//
// This is the ground truth of the whole suite. Every claim of "improvement"
// from any loop is checked against the score this harness produces. The
// scoring here is DETERMINISTIC: a fixed set of tasks with known answers,
// graded by exact / numeric / substring matchers — never by a model's
// self-assessment. That is what makes it un-gameable: a loop can lie about
// its own metrics, but it cannot move this number without genuinely answering
// the known-answer tasks correctly.
//
// Two modes:
//   - scoreAnswers(answers)  — PURE. Grade a supplied answer map. Deterministic,
//     no network. Used by the smoke and by anti-gaming verification.
//   - runBenchmark(opts)     — LIVE. Ask the target model each task, then grade.
//     Sequential (one model loaded at a time on the 8GB rig). Graceful: a
//     failed task scores 0, never throws.

import { getOllamaBase } from "../ollama-config";
import { PERSONA_BY_ID } from "../personas";

export type Matcher = "numeric" | "exact_ci" | "contains_ci" | "contains_all";

export interface BenchmarkTask {
  id: string;
  category: "math" | "factual" | "logic" | "format" | "reasoning";
  prompt: string;
  expected: string;
  match: Matcher;
  /** Weight in the aggregate score (default 1). */
  weight?: number;
}

// The fixed ground-truth set. Known answers, deterministically checkable.
// Keep prompts terse + answer-constrained so grading is unambiguous.
export const BENCHMARK_TASKS: BenchmarkTask[] = [
  { id: "math-1", category: "math", prompt: "Compute 17 * 23. Reply with only the number.", expected: "391", match: "numeric" },
  { id: "math-2", category: "math", prompt: "What is 144 divided by 12? Reply with only the number.", expected: "12", match: "numeric" },
  { id: "math-3", category: "math", prompt: "What is 2 to the power of 10? Reply with only the number.", expected: "1024", match: "numeric" },
  { id: "math-4", category: "math", prompt: "A train travels 60 miles in 1.5 hours. What is its average speed in mph? Reply with only the number.", expected: "40", match: "numeric" },
  { id: "geo-1", category: "factual", prompt: "What is the capital of France? Reply with one word.", expected: "Paris", match: "contains_ci" },
  { id: "geo-2", category: "factual", prompt: "What is the capital of Japan? Reply with one word.", expected: "Tokyo", match: "contains_ci" },
  { id: "sci-1", category: "factual", prompt: "What is the chemical symbol for gold? Reply with the symbol only.", expected: "Au", match: "exact_ci" },
  { id: "sci-2", category: "factual", prompt: "How many planets are in our solar system? Reply with only the number.", expected: "8", match: "numeric" },
  { id: "logic-1", category: "logic", prompt: "If all roses are flowers and some flowers fade quickly, can we conclude all roses fade quickly? Answer yes or no.", expected: "no", match: "contains_ci" },
  { id: "logic-2", category: "logic", prompt: "Mary is older than Tom. Tom is older than Sue. Who is youngest? Reply with the name.", expected: "Sue", match: "contains_ci" },
  { id: "fmt-1", category: "format", prompt: "Reply with exactly the word ACKNOWLEDGED and nothing else.", expected: "ACKNOWLEDGED", match: "contains_ci" },
  { id: "reason-1", category: "reasoning", prompt: "A bat and a ball cost $1.10 total. The bat costs $1.00 more than the ball. How much does the ball cost in cents? Reply with only the number.", expected: "5", match: "numeric" },
];

const TASK_INDEX: Record<string, BenchmarkTask> = Object.fromEntries(
  BENCHMARK_TASKS.map((t) => [t.id, t])
);

/** All benchmark task ids — used as known refs by the eval gate. */
export function benchmarkTaskIds(): string[] {
  return BENCHMARK_TASKS.map((t) => t.id);
}

function firstNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[.!?"']/g, "").replace(/\s+/g, " ");
}

/** Grade a single answer against a task. Deterministic. */
export function gradeTask(task: BenchmarkTask, answer: string): boolean {
  const a = (answer ?? "").trim();
  if (!a) return false;
  switch (task.match) {
    case "numeric": {
      const got = firstNumber(a);
      const want = firstNumber(task.expected);
      return got !== null && want !== null && Math.abs(got - want) < 1e-9;
    }
    case "exact_ci":
      return norm(a) === norm(task.expected);
    case "contains_ci":
      return norm(a).includes(norm(task.expected));
    case "contains_all":
      return task.expected
        .split("|")
        .every((part) => norm(a).includes(norm(part)));
    default:
      return false;
  }
}

export interface BenchmarkPerTask {
  id: string;
  category: string;
  passed: boolean;
  expected: string;
  answer: string;
}

export interface BenchmarkScore {
  score: number; // weighted fraction in [0,1]
  passed: number;
  total: number;
  perTask: BenchmarkPerTask[];
  model: string | null;
  at: string;
}

/**
 * PURE grader. Grade a supplied answer map (taskId → answer). Deterministic,
 * no network. Unknown task ids are ignored; missing answers count as wrong.
 */
export function scoreAnswers(
  answers: Record<string, string>,
  opts: { model?: string | null } = {}
): BenchmarkScore {
  let weightSum = 0;
  let weightPass = 0;
  let passed = 0;
  const perTask: BenchmarkPerTask[] = [];
  for (const task of BENCHMARK_TASKS) {
    const w = task.weight ?? 1;
    weightSum += w;
    const answer = answers[task.id] ?? "";
    const ok = gradeTask(task, answer);
    if (ok) {
      passed += 1;
      weightPass += w;
    }
    perTask.push({
      id: task.id,
      category: task.category,
      passed: ok,
      expected: task.expected,
      answer: answer.slice(0, 200),
    });
  }
  return {
    score: weightSum > 0 ? weightPass / weightSum : 0,
    passed,
    total: BENCHMARK_TASKS.length,
    perTask,
    model: opts.model ?? null,
    at: new Date().toISOString(),
  };
}

const ASK_TIMEOUT_MS = 30_000;

/** Ask the target model one task. Returns the raw answer ("" on failure). */
async function askModel(model: string, prompt: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [
          {
            role: "system",
            content:
              "You are taking a short factual benchmark. Answer each question as briefly and literally as instructed. No explanation unless asked.",
          },
          { role: "user", content: prompt },
        ],
        options: { temperature: 0, num_predict: 64 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? "").trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the benchmark model — Bobby (fastest), else the provided override. */
export function benchmarkModel(override?: string): string {
  if (override && override.length > 0) return override;
  return PERSONA_BY_ID.bobby?.model || "CyberCrew/notmythos-8b:latest";
}

/**
 * LIVE benchmark. Ask the model every task (sequential — one model loaded at a
 * time), grade deterministically, return the ground-truth score. Graceful: any
 * single task that fails to get an answer scores 0; never throws.
 */
export async function runBenchmark(
  opts: { model?: string; subset?: string[] } = {}
): Promise<BenchmarkScore> {
  const model = benchmarkModel(opts.model);
  const tasks = opts.subset
    ? BENCHMARK_TASKS.filter((t) => opts.subset!.includes(t.id))
    : BENCHMARK_TASKS;
  const answers: Record<string, string> = {};
  for (const task of tasks) {
    answers[task.id] = await askModel(model, task.prompt);
  }
  // Grade only the tasks we ran (subset-aware) by scoring against the full set
  // but with unrun tasks absent. For a subset run, restrict the denominator.
  if (opts.subset) {
    let pass = 0;
    const perTask: BenchmarkPerTask[] = [];
    for (const task of tasks) {
      const ok = gradeTask(task, answers[task.id] ?? "");
      if (ok) pass += 1;
      perTask.push({
        id: task.id,
        category: task.category,
        passed: ok,
        expected: task.expected,
        answer: (answers[task.id] ?? "").slice(0, 200),
      });
    }
    return {
      score: tasks.length > 0 ? pass / tasks.length : 0,
      passed: pass,
      total: tasks.length,
      perTask,
      model,
      at: new Date().toISOString(),
    };
  }
  return scoreAnswers(answers, { model });
}

/** Locate a task by id (for the API + UI). */
export function getBenchmarkTask(id: string): BenchmarkTask | null {
  return TASK_INDEX[id] ?? null;
}
