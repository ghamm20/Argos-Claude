// lib/loops/lessons.ts
//
// Self-Evolving Loop Suite — the Reflexion lesson store. Lessons are the
// distilled "don't do that again" from failures. Unlike traces (append-only
// audit), the lesson index is a working store with mutable counters: how many
// times the same failure recurred, how often the lesson was reused, and the
// measured score impact when it was. If the SAME failure recurs 3+ times, the
// operator is paged — a lesson that keeps failing is a real problem.
//
// Stored as an atomic JSON array at state/loops/lessons.json (rewritable; the
// audit trail lives in the append-only traces, not here).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";
import { pushoverSend } from "../research/alerts";

export interface Lesson {
  id: string;
  lesson: string;
  source: string;
  createdAt: string;
  lastSeenAt: string;
  failureCount: number; // times the same failure recurred (incl. first)
  reuseCount: number; // times the lesson was injected/applied downstream
  scoreDeltas: number[]; // measured impact when reused
  alerted: boolean; // already paged at the 3+ threshold
}

const REPEAT_ALERT_THRESHOLD = 3;

function lessonsPath(): string {
  return path.join(argosRoot(), "state", "loops", "lessons.json");
}

export async function readLessons(): Promise<Lesson[]> {
  try {
    const raw = await fsp.readFile(lessonsPath(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Lesson[]) : [];
  } catch {
    return [];
  }
}

async function writeLessons(all: Lesson[]): Promise<void> {
  const p = lessonsPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
  await fsp.rename(tmp, p);
}

function keywords(s: string): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Find a stored lesson whose source is similar to `source` (Jaccard ≥ 0.4). */
export function findSimilarLesson(source: string, lessons: Lesson[]): Lesson | null {
  const k = keywords(source);
  let best: Lesson | null = null;
  let bestScore = 0.4;
  for (const l of lessons) {
    const s = jaccard(k, keywords(l.source));
    if (s >= bestScore) {
      bestScore = s;
      best = l;
    }
  }
  return best;
}

export interface RecordLessonResult {
  lesson: Lesson;
  recurred: boolean;
  failureCount: number;
  alerted: boolean;
}

/**
 * Record a lesson from a failure. If a similar failure is already on file, bump
 * its failureCount (this failure recurred); otherwise create a new lesson. Pages
 * the operator the first time a failure crosses the 3× threshold. Never throws.
 */
export async function recordFailureLesson(
  lessonText: string,
  source: string
): Promise<RecordLessonResult> {
  const all = await readLessons();
  const now = new Date().toISOString();
  const existing = findSimilarLesson(source, all);
  let alerted = false;

  if (existing) {
    existing.failureCount += 1;
    existing.lastSeenAt = now;
    if (lessonText) existing.lesson = lessonText; // refine the lesson
    if (existing.failureCount >= REPEAT_ALERT_THRESHOLD && !existing.alerted) {
      try {
        const delivery = await pushoverSend({
          title: "⚠ ARGOS — a lesson keeps failing",
          message: `The same failure has recurred ${existing.failureCount}× despite the lesson:\n"${existing.lesson}"\n\nSource: ${source.slice(0, 300)}`,
          priority: "1",
        });
        alerted = delivery.sent;
      } catch {
        /* alert best-effort */
      }
      existing.alerted = true;
    }
    await writeLessons(all);
    return { lesson: existing, recurred: true, failureCount: existing.failureCount, alerted };
  }

  const lesson: Lesson = {
    id: randomUUID().slice(0, 8),
    lesson: lessonText,
    source: source.slice(0, 600),
    createdAt: now,
    lastSeenAt: now,
    failureCount: 1,
    reuseCount: 0,
    scoreDeltas: [],
    alerted: false,
  };
  all.push(lesson);
  await writeLessons(all);
  return { lesson, recurred: false, failureCount: 1, alerted };
}

/** Record the measured impact of reusing a lesson (e.g. score delta on the next
 *  similar task). Used by trace-analysis / reward-optimization. Never throws. */
export async function recordLessonImpact(id: string, scoreDelta: number): Promise<void> {
  try {
    const all = await readLessons();
    const l = all.find((x) => x.id === id);
    if (!l) return;
    l.reuseCount += 1;
    if (Number.isFinite(scoreDelta)) l.scoreDeltas.push(scoreDelta);
    await writeLessons(all);
  } catch {
    /* best effort */
  }
}

export interface LessonStats {
  total: number;
  recurring: number; // failureCount >= 3
  topRepeated: Array<{ lesson: string; failureCount: number }>;
}

export async function lessonStats(): Promise<LessonStats> {
  const all = await readLessons();
  const recurring = all.filter((l) => l.failureCount >= REPEAT_ALERT_THRESHOLD);
  const topRepeated = [...all]
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 5)
    .map((l) => ({ lesson: l.lesson, failureCount: l.failureCount }));
  return { total: all.length, recurring: recurring.length, topRepeated };
}
