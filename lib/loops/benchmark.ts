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

export type Matcher =
  | "numeric"
  | "exact_ci"
  | "contains_ci"
  | "contains_all"
  | "word_count_max" // answer's word count <= Number(expected)
  | "not_contains" // answer must NOT contain expected
  | "sentence_count_max"; // answer's sentence count <= Number(expected)

/**
 * Benchmark categories. reasoning + retrieval are knowledge/recall tasks;
 * tool_chain + character + quality are gradable PROXIES — deterministic format
 * / constraint checks that stand in for the harder-to-grade real thing (an
 * honest approximation, not a full evaluation). Every task is deterministically
 * graded so the harness stays un-gameable ground truth.
 */
export type BenchmarkCategory =
  | "reasoning"
  | "retrieval"
  | "tool_chain"
  | "character"
  | "quality"
  | "math"
  | "factual"
  | "logic"
  | "format";

export interface BenchmarkTask {
  id: string;
  category: BenchmarkCategory;
  prompt: string;
  expected: string;
  match: Matcher;
  /** Weight in the aggregate score (default 1). */
  weight?: number;
}

// The fixed ground-truth set: 35 tasks across 5 categories, every one
// deterministically graded. Known answers, terse + answer-constrained prompts.
export const BENCHMARK_TASKS: BenchmarkTask[] = [
  // ----- reasoning (10): math + logic, exact answers -----
  { id: "reason-1", category: "reasoning", prompt: "Compute 17 * 23. Reply with only the number.", expected: "391", match: "numeric" },
  { id: "reason-2", category: "reasoning", prompt: "What is 144 divided by 12? Reply with only the number.", expected: "12", match: "numeric" },
  { id: "reason-3", category: "reasoning", prompt: "What is 2 to the power of 10? Reply with only the number.", expected: "1024", match: "numeric" },
  { id: "reason-4", category: "reasoning", prompt: "A train travels 60 miles in 1.5 hours. Average speed in mph? Reply with only the number.", expected: "40", match: "numeric" },
  { id: "reason-5", category: "reasoning", prompt: "A bat and ball cost $1.10. The bat costs $1.00 more than the ball. Ball cost in cents? Reply with only the number.", expected: "5", match: "numeric" },
  { id: "reason-6", category: "reasoning", prompt: "If all roses are flowers and some flowers fade quickly, can we conclude all roses fade quickly? Answer yes or no.", expected: "no", match: "contains_ci" },
  { id: "reason-7", category: "reasoning", prompt: "Mary is older than Tom. Tom is older than Sue. Who is youngest? Reply with the name.", expected: "Sue", match: "contains_ci" },
  { id: "reason-8", category: "reasoning", prompt: "What is 15% of 200? Reply with only the number.", expected: "30", match: "numeric" },
  { id: "reason-9", category: "reasoning", prompt: "What is the next number in the sequence 2, 4, 8, 16? Reply with only the number.", expected: "32", match: "numeric" },
  { id: "reason-10", category: "reasoning", prompt: "If today is Monday, what day is it 3 days later? Reply with the day.", expected: "Thursday", match: "contains_ci" },
  // ----- retrieval (10): known-answer recall -----
  { id: "ret-1", category: "retrieval", prompt: "What is the capital of France? One word.", expected: "Paris", match: "contains_ci" },
  { id: "ret-2", category: "retrieval", prompt: "What is the capital of Japan? One word.", expected: "Tokyo", match: "contains_ci" },
  { id: "ret-3", category: "retrieval", prompt: "Chemical symbol for gold? Symbol only.", expected: "Au", match: "exact_ci" },
  { id: "ret-4", category: "retrieval", prompt: "How many planets are in our solar system? Number only.", expected: "8", match: "numeric" },
  { id: "ret-5", category: "retrieval", prompt: "What is the largest planet in our solar system? One word.", expected: "Jupiter", match: "contains_ci" },
  { id: "ret-6", category: "retrieval", prompt: "How many continents are there on Earth? Number only.", expected: "7", match: "numeric" },
  { id: "ret-7", category: "retrieval", prompt: "Who wrote Romeo and Juliet? Last name only.", expected: "Shakespeare", match: "contains_ci" },
  { id: "ret-8", category: "retrieval", prompt: "What is the common name for H2O? One word.", expected: "water", match: "contains_ci" },
  { id: "ret-9", category: "retrieval", prompt: "How many sides does a hexagon have? Number only.", expected: "6", match: "numeric" },
  { id: "ret-10", category: "retrieval", prompt: "In what year did World War II end? Year only.", expected: "1945", match: "numeric" },
  // ----- tool_chain (5): ordered/procedural multi-part output (proxy) -----
  { id: "tc-1", category: "tool_chain", prompt: "List the 3 primary colors, comma separated.", expected: "red|blue|yellow", match: "contains_all" },
  { id: "tc-2", category: "tool_chain", prompt: "Name the first 3 planets from the sun in order, comma separated.", expected: "mercury|venus|earth", match: "contains_all" },
  { id: "tc-3", category: "tool_chain", prompt: "List all 4 cardinal directions.", expected: "north|south|east|west", match: "contains_all" },
  { id: "tc-4", category: "tool_chain", prompt: "List the 3 classic states of matter.", expected: "solid|liquid|gas", match: "contains_all" },
  { id: "tc-5", category: "tool_chain", prompt: "Give the 3 steps to make tea (heat water, add tea, steep). List them.", expected: "water|tea|steep", match: "contains_all" },
  // ----- character (5): constraint-following (proxy for consistency) -----
  { id: "char-1", category: "character", prompt: "Reply with exactly one word: the color of a clear daytime sky.", expected: "2", match: "word_count_max" },
  { id: "char-2", category: "character", prompt: "Answer in 5 words or fewer: what is 2 + 2?", expected: "5", match: "word_count_max" },
  { id: "char-3", category: "character", prompt: "Describe water in one sentence WITHOUT using the word 'wet'.", expected: "wet", match: "not_contains" },
  { id: "char-4", category: "character", prompt: "Reply with only YES or NO: is the sun a star?", expected: "3", match: "word_count_max" },
  { id: "char-5", category: "character", prompt: "Reply in at most 3 words: the capital of Italy.", expected: "3", match: "word_count_max" },
  // ----- quality (5): conciseness / format adherence (proxy) -----
  { id: "qual-1", category: "quality", prompt: "Answer in exactly one sentence: what is gravity?", expected: "1", match: "sentence_count_max" },
  { id: "qual-2", category: "quality", prompt: "In one sentence, define a firewall.", expected: "1", match: "sentence_count_max" },
  { id: "qual-3", category: "quality", prompt: "Summarize 'the cat sat on the mat' in 5 words or fewer.", expected: "5", match: "word_count_max" },
  { id: "qual-4", category: "quality", prompt: "Give a one-sentence reason to back up your data.", expected: "1", match: "sentence_count_max" },
  { id: "qual-5", category: "quality", prompt: "In under 20 words, why is sleep important?", expected: "20", match: "word_count_max" },
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
    case "word_count_max": {
      const max = Number(task.expected);
      const words = a.split(/\s+/).filter(Boolean).length;
      return Number.isFinite(max) && words <= max && words > 0;
    }
    case "not_contains":
      return !norm(a).includes(norm(task.expected));
    case "sentence_count_max": {
      const max = Number(task.expected);
      const enders = (a.match(/[.!?]+/g) ?? []).length;
      const sentences = enders === 0 ? 1 : enders;
      return Number.isFinite(max) && sentences <= max;
    }
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

export type ByCategory = Record<string, { pass: number; total: number; score: number }>;

export interface BenchmarkScore {
  score: number; // weighted fraction in [0,1]
  passed: number;
  total: number;
  perTask: BenchmarkPerTask[];
  byCategory: ByCategory;
  model: string | null;
  at: string;
}

/** Per-category pass rates — used by active-learning + the regression gate. */
export function computeByCategory(perTask: BenchmarkPerTask[]): ByCategory {
  const out: ByCategory = {};
  for (const t of perTask) {
    out[t.category] = out[t.category] ?? { pass: 0, total: 0, score: 0 };
    out[t.category].total += 1;
    if (t.passed) out[t.category].pass += 1;
  }
  for (const c of Object.values(out)) c.score = c.total > 0 ? c.pass / c.total : 0;
  return out;
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
    byCategory: computeByCategory(perTask),
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
      byCategory: computeByCategory(perTask),
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
