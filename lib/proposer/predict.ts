// lib/proposer/predict.ts
//
// Phase 4 (2026-06-10) — THE PREDICTION LAYER (ReWOO, not ReAct).
//
// Plan-ahead: Bart emits the top-3 predicted next-asks WITH probabilities
// BEFORE any pre-staging happens. There is no act-observe loop here — the
// whole plan is produced up front from the observation corpus, then (and
// only then) the >70% pre-fetch hook may turn predictions into PROPOSALS
// (lib/proposer/propose.ts). Nothing executes without operator approval.
//
// NAMED REASONING TYPES (owner design doctrine, IBM/Milvus review):
//
//   ABDUCTIVE      — intent inference from the observation corpus: a
//                    transition matrix P(next class | current class) built
//                    from corpus bigrams infers the most plausible next
//                    intent given what the operator just asked.
//   TEMPORAL       — time-of-day patterns: per-hour-bucket topic frequencies
//                    from corpus timestamps weight candidates by when the
//                    operator historically asks them.
//   ANALOGICAL     — NEVER unaided: the SYMBOLIC layer retrieves candidate
//                    analogous cases (past corpus positions whose preceding
//                    (topic_class, query_type) bigram matches the current
//                    tail); candidates are what actually followed those
//                    cases. The LLM only ever reasons over these RETRIEVED
//                    candidates — it cannot introduce new ones.
//   PROBABILISTIC  — confidence: candidates carry empirical probabilities
//                    (normalized mixture of the three generators above);
//                    calibration is tracked via Brier score against
//                    next-observation ground truth through lib/verifier/.
//   NEURO-SYMBOLIC — the symbolic planner GENERATES the branches; the LLM
//                    SCORES only (rank adjustment + one-line rationale).
//                    Model unavailable → symbolic ranking stands alone
//                    (graceful degradation, no fabricated scores).
//
// ALL PREDICTIONS ARE CLAIMS: each emitted prediction is wrapped in a claim
// envelope (lib/verifier/schema.ts), recorded to the hash-chained audit
// log + verifier ledger, and SCORED when the next observation lands.
// Silent guessing = integrity violation; there is no unrecorded prediction
// path in this module.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { readObservations, type ObservationEntry, type TopicClass, type QueryType } from "../observation";
import { makeClaim, recordClaim, recordOutcome } from "../verifier/schema";
import { callModel } from "../tools/util";
import { PERSONA_BY_ID } from "../personas";

export type ReasoningType = "abductive" | "temporal" | "analogical" | "probabilistic" | "neuro-symbolic";

export interface PredictedAsk {
  topicClass: TopicClass;
  queryType: QueryType;
  /** Empirical probability in [0,1] from the probabilistic fusion. */
  probability: number;
  /** Which named reasoning generators contributed this candidate. */
  reasoning: ReasoningType[];
  /** One-line human rationale (symbolic; LLM may refine when available). */
  rationale: string;
  /** Claim id once recorded (every emitted prediction IS a claim). */
  claimId: string;
}

export function proposerDir(): string {
  return path.join(argosRoot(), "state", "proposer");
}
function predictionsPath(): string {
  return path.join(proposerDir(), "predictions.jsonl");
}
function calibrationPath(): string {
  return path.join(proposerDir(), "calibration.json");
}

interface PredictionRecord {
  claimId: string;
  at: string;
  sessionId: string | null;
  /** Index of the LAST corpus entry visible at prediction time — the
   *  prediction is judged against the FIRST entry after this index. */
  baseIndex: number;
  topicClass: TopicClass;
  queryType: QueryType;
  probability: number;
  reasoning: ReasoningType[];
  scored: boolean;
}

// ---- symbolic generators (deterministic, corpus-only, zero model calls) ----

type Key = string; // `${topic_class}|${query_type}`
const keyOf = (o: { topic_class: TopicClass; query_type: QueryType }): Key => `${o.topic_class}|${o.query_type}`;
const parseKey = (k: Key): { topicClass: TopicClass; queryType: QueryType } => {
  const [t, q] = k.split("|");
  return { topicClass: t as TopicClass, queryType: q as QueryType };
};

/** ABDUCTIVE — P(next | current) transition counts over corpus bigrams
 *  (session-scoped: transitions never cross session boundaries). */
export function abductiveCandidates(corpus: ObservationEntry[], current: ObservationEntry | null): Map<Key, number> {
  const out = new Map<Key, number>();
  if (!current) return out;
  for (let i = 1; i < corpus.length; i++) {
    const prev = corpus[i - 1];
    const next = corpus[i];
    if (prev.session_id !== next.session_id) continue;
    if (prev.topic_class === current.topic_class) {
      out.set(keyOf(next), (out.get(keyOf(next)) ?? 0) + 1);
    }
  }
  return out;
}

/** TEMPORAL — topic frequencies within the current hour bucket
 *  (00-05 night / 06-11 morning / 12-17 afternoon / 18-23 evening). */
export function temporalCandidates(corpus: ObservationEntry[], now: Date): Map<Key, number> {
  const bucket = (h: number) => Math.floor(h / 6);
  const nowBucket = bucket(now.getHours());
  const out = new Map<Key, number>();
  for (const o of corpus) {
    const h = new Date(o.timestamp).getHours();
    if (Number.isFinite(h) && bucket(h) === nowBucket) {
      out.set(keyOf(o), (out.get(keyOf(o)) ?? 0) + 1);
    }
  }
  return out;
}

/** ANALOGICAL (retrieval-bounded) — find past positions whose preceding
 *  bigram matches the current 2-entry tail; candidates are what FOLLOWED.
 *  This is the symbolic retrieval that bounds the LLM: only these
 *  candidates ever reach the scorer. */
export function analogicalCandidates(corpus: ObservationEntry[], tail: ObservationEntry[]): Map<Key, number> {
  const out = new Map<Key, number>();
  if (tail.length < 2) return out;
  const [a, b] = tail.slice(-2);
  for (let i = 2; i < corpus.length; i++) {
    const p2 = corpus[i - 2];
    const p1 = corpus[i - 1];
    const next = corpus[i];
    if (p2.session_id !== next.session_id || p1.session_id !== next.session_id) continue;
    if (keyOf(p2) === keyOf(a) && keyOf(p1) === keyOf(b)) {
      out.set(keyOf(next), (out.get(keyOf(next)) ?? 0) + 1);
    }
  }
  return out;
}

/** PROBABILISTIC fusion — normalized weighted mixture of the generators.
 *  Analogical matches are the strongest signal (exact sequence echo),
 *  then abductive transitions, then temporal priors. */
const WEIGHTS = { analogical: 0.5, abductive: 0.35, temporal: 0.15 };

export interface SymbolicBranch {
  key: Key;
  probability: number;
  reasoning: ReasoningType[];
}

export function fuseBranches(
  abductive: Map<Key, number>,
  temporal: Map<Key, number>,
  analogical: Map<Key, number>
): SymbolicBranch[] {
  const norm = (m: Map<Key, number>) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const out = new Map<Key, number>();
    if (total > 0) for (const [k, v] of m) out.set(k, v / total);
    return out;
  };
  const an = norm(abductive), tn = norm(temporal), gn = norm(analogical);
  const keys = new Set<Key>([...an.keys(), ...tn.keys(), ...gn.keys()]);
  const branches: SymbolicBranch[] = [];
  for (const k of keys) {
    const pa = an.get(k) ?? 0, pt = tn.get(k) ?? 0, pg = gn.get(k) ?? 0;
    const p = WEIGHTS.abductive * pa + WEIGHTS.temporal * pt + WEIGHTS.analogical * pg;
    const reasoning: ReasoningType[] = ["probabilistic"];
    if (pg > 0) reasoning.push("analogical");
    if (pa > 0) reasoning.push("abductive");
    if (pt > 0) reasoning.push("temporal");
    branches.push({ key: k, probability: p, reasoning });
  }
  branches.sort((a, b) => b.probability - a.probability);
  // Renormalize over the emitted set so probabilities are honest within it.
  const total = branches.reduce((a, b) => a + b.probability, 0);
  if (total > 0) for (const b of branches) b.probability = b.probability / total;
  return branches;
}

// ---- NEURO-SYMBOLIC scoring: LLM ranks the RETRIEVED branches only ----

async function llmScoreBranches(
  branches: SymbolicBranch[],
  current: ObservationEntry | null
): Promise<Map<Key, string>> {
  const rationales = new Map<Key, string>();
  if (branches.length === 0) return rationales;
  const list = branches
    .map((b, i) => `${i + 1}. class=${b.key} p=${b.probability.toFixed(2)} via=${b.reasoning.join("+")}`)
    .join("\n");
  const system =
    "You are Bartimaeus, scoring PRE-GENERATED predictions of the operator's next ask. " +
    "You may ONLY rank and annotate the candidates listed — never invent new ones. " +
    'Output ONLY a JSON array of {"index": n, "rationale": "one short line"} covering each candidate. No prose.';
  const user = [
    current ? `The operator's last ask was class=${current.topic_class}/${current.query_type}.` : "No current context.",
    "Candidates (symbolically generated from the observation corpus):",
    list,
  ].join("\n");
  try {
    const out = await callModel(PERSONA_BY_ID.bartimaeus.model, system, user, { timeoutMs: 60_000 });
    const s = out.indexOf("["), e = out.lastIndexOf("]");
    if (s >= 0 && e > s) {
      const arr = JSON.parse(out.slice(s, e + 1)) as Array<{ index?: number; rationale?: string }>;
      for (const it of arr) {
        const idx = typeof it.index === "number" ? it.index - 1 : -1;
        if (idx >= 0 && idx < branches.length && typeof it.rationale === "string") {
          rationales.set(branches[idx].key, it.rationale.slice(0, 160));
        }
      }
    }
  } catch {
    /* NEURO-SYMBOLIC degradation: symbolic ranking stands; no fabricated scores */
  }
  return rationales;
}

// ---- the ReWOO entry point ----

export interface PredictOptions {
  now?: Date;
  /** Skip the LLM scorer (deterministic mode for tests). */
  symbolicOnly?: boolean;
}

/** Plan ahead: top-3 predicted next-asks with probabilities, every one
 *  recorded as a claim BEFORE this function returns. Read-only on the
 *  observation corpus. */
export async function predictNextAsks(opts: PredictOptions = {}): Promise<PredictedAsk[]> {
  const corpus = await readObservations();
  if (corpus.length === 0) return [];
  const current = corpus[corpus.length - 1] ?? null;
  const tail = corpus.filter((o) => o.session_id === current?.session_id);

  const branches = fuseBranches(
    abductiveCandidates(corpus, current),
    temporalCandidates(corpus, opts.now ?? new Date()),
    analogicalCandidates(corpus, tail)
  ).slice(0, 3);

  const rationales = opts.symbolicOnly ? new Map<Key, string>() : await llmScoreBranches(branches, current);

  const out: PredictedAsk[] = [];
  for (const b of branches) {
    const { topicClass, queryType } = parseKey(b.key);
    const reasoning: ReasoningType[] = [...b.reasoning, "neuro-symbolic"];
    const rationale =
      rationales.get(b.key) ??
      `symbolic: ${b.reasoning.filter((r) => r !== "probabilistic").join("+") || "prior"} evidence from the observation corpus`;
    // EVERY prediction is a claim — recorded before it is returned.
    const claim = makeClaim(
      "proposer.predict",
      `predicts next operator ask class=${topicClass}/${queryType} with p=${b.probability.toFixed(3)}`,
      { type: "none" }
    );
    await recordClaim(claim);
    const rec: PredictionRecord = {
      claimId: claim.id,
      at: new Date().toISOString(),
      sessionId: current?.session_id ?? null,
      baseIndex: corpus.length - 1,
      topicClass,
      queryType,
      probability: b.probability,
      reasoning,
      scored: false,
    };
    await fsp.mkdir(proposerDir(), { recursive: true });
    await fsp.appendFile(predictionsPath(), JSON.stringify(rec) + "\n", "utf8");
    out.push({ topicClass, queryType, probability: b.probability, reasoning, rationale, claimId: claim.id });
  }
  return out;
}

// ---- Brier calibration: score predictions against the next observation ----

export interface Calibration {
  n: number;
  brier: number;
  hits: number;
  lastUpdated: string;
}

async function readPredictions(): Promise<PredictionRecord[]> {
  try {
    return (await fsp.readFile(predictionsPath(), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Score every unscored prediction whose next observation has arrived.
 *  Ground truth = the FIRST corpus entry after baseIndex. A prediction is a
 *  HIT when its topic_class matches (query_type tracked in evidence). Each
 *  scored prediction gets a verifier OUTCOME (mechanical, evidence = the
 *  actual class); Brier = mean((p - hit)^2) over all scored predictions. */
export async function scorePredictions(): Promise<Calibration> {
  const corpus = await readObservations();
  const preds = await readPredictions();
  let scoredAny = false;
  for (const p of preds) {
    if (p.scored) continue;
    const actual = corpus[p.baseIndex + 1];
    if (!actual) continue; // next ask hasn't happened yet
    const hit = actual.topic_class === p.topicClass;
    await recordOutcome({
      claimId: p.claimId,
      at: new Date().toISOString(),
      verdict: hit ? "verified" : "failed",
      method: "mechanical",
      evidence: `actual next ask class=${actual.topic_class}/${actual.query_type} (predicted ${p.topicClass}/${p.queryType} p=${p.probability.toFixed(3)})`,
    });
    p.scored = true;
    scoredAny = true;
  }
  if (scoredAny) {
    // Rewrite the predictions file with scored flags (atomic temp+rename).
    const tmp = `${predictionsPath()}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, preds.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
    await fsp.rename(tmp, predictionsPath());
  }
  // Brier over everything scored — recomputed, never asserted from memory.
  const corpus2 = corpus; // ground truth source above
  let n = 0, hits = 0, sum = 0;
  for (const p of preds) {
    const actual = corpus2[p.baseIndex + 1];
    if (!actual) continue;
    const hit = actual.topic_class === p.topicClass ? 1 : 0;
    n += 1;
    hits += hit;
    sum += (p.probability - hit) ** 2;
  }
  const cal: Calibration = { n, brier: n > 0 ? sum / n : 0, hits, lastUpdated: new Date().toISOString() };
  await fsp.mkdir(proposerDir(), { recursive: true });
  await fsp.writeFile(calibrationPath(), JSON.stringify(cal, null, 2), "utf8");
  return cal;
}
