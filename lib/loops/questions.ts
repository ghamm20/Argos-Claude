// lib/loops/questions.ts
//
// Self-Evolving Loop Suite — the Active-Learning question store. When ARGOS is
// genuinely uncertain it asks the operator ONE focused question. The store
// dedups so it never asks the same thing twice, and keeps the answer
// permanently once given. Atomic JSON array at state/loops/questions.json.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { argosRoot } from "../vault/paths";

export interface OpenQuestion {
  id: string;
  question: string;
  category: string;
  askedAt: string;
  answered: boolean;
  answer: string | null;
  answeredAt: string | null;
}

function questionsPath(): string {
  return path.join(argosRoot(), "state", "loops", "questions.json");
}

export async function readQuestions(): Promise<OpenQuestion[]> {
  try {
    const arr = JSON.parse(await fsp.readFile(questionsPath(), "utf8"));
    return Array.isArray(arr) ? (arr as OpenQuestion[]) : [];
  } catch {
    return [];
  }
}

async function writeQuestions(all: OpenQuestion[]): Promise<void> {
  const p = questionsPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
  await fsp.rename(tmp, p);
}

function norm(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Has an equivalent question already been asked? (substring/equality on the
 *  normalized text — cheap + good enough to never nag.) */
export function alreadyAsked(question: string, all: OpenQuestion[]): boolean {
  const q = norm(question);
  if (!q) return true;
  return all.some((x) => {
    const e = norm(x.question);
    return e === q || e.includes(q) || q.includes(e);
  });
}

export interface RecordQuestionResult {
  recorded: boolean; // false if it was a duplicate
  question: OpenQuestion | null;
}

/** Record a new question unless an equivalent one already exists OR there is
 *  already an UNANSWERED question for the same gap (category). The latter is
 *  what makes "never ask twice" hold even though the model phrases the question
 *  differently each run — we dedup on the gap, not the wording. */
export async function recordQuestion(question: string, category: string): Promise<RecordQuestionResult> {
  const all = await readQuestions();
  const pendingSameCategory = all.some((q) => !q.answered && q.category === category);
  if (pendingSameCategory || alreadyAsked(question, all)) return { recorded: false, question: null };
  const q: OpenQuestion = {
    id: randomUUID().slice(0, 8),
    question: question.trim().slice(0, 500),
    category,
    askedAt: new Date().toISOString(),
    answered: false,
    answer: null,
    answeredAt: null,
  };
  all.push(q);
  await writeQuestions(all);
  return { recorded: true, question: q };
}

/** Answer a question permanently. Never throws. */
export async function answerQuestion(id: string, answer: string): Promise<boolean> {
  const all = await readQuestions();
  const q = all.find((x) => x.id === id);
  if (!q) return false;
  q.answered = true;
  q.answer = answer.trim().slice(0, 1000);
  q.answeredAt = new Date().toISOString();
  await writeQuestions(all);
  return true;
}

export async function pendingQuestions(): Promise<OpenQuestion[]> {
  return (await readQuestions()).filter((q) => !q.answered);
}
