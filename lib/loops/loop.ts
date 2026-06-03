// lib/loops/loop.ts
//
// Self-Evolving Loop Suite (2026-06-02) — the shared loop interface + a single
// model-call helper every loop uses. A loop is a pure function from context to
// a LoopResult; it NEVER applies its own changes and NEVER throws out (the
// orchestrator wraps it, but loops should still catch + return loopFail).

import { getOllamaBase, KEEP_ALIVE_BACKGROUND } from "../ollama-config";
import { PERSONA_BY_ID, type PersonaId } from "../personas";
import type { LoopId, LoopResult, LoopTrigger } from "./types";

export interface LoopContext {
  trigger: LoopTrigger;
  sessionId: string | null;
  /** Loop-specific input (e.g. /refine text, /debate topic, /simulate action). */
  input?: Record<string, unknown>;
}

export interface LoopSchedule {
  /** 0=Sun..6=Sat, or "daily". */
  dayOfWeek: number | "daily";
  hour: number; // 0-23
  minute: number; // 0-59
  label: string; // human label, e.g. "nightly 2AM"
}

export interface LoopDefinition {
  id: LoopId;
  loopNumber: number;
  name: string;
  description: string;
  trigger: "manual" | "scheduled" | "command";
  /** Present when trigger === "scheduled". */
  schedule?: LoopSchedule;
  /** Present when trigger === "command" (e.g. "refine", "debate"). */
  command?: string;
  /** True for loops that can propose high-risk (code/config/governance) change. */
  governed?: boolean;
  run(ctx: LoopContext): Promise<LoopResult>;
}

/** The Ollama model bound to a persona, or "" if not configured. */
export function personaModel(id: PersonaId): string {
  return PERSONA_BY_ID[id]?.model || "";
}

/**
 * One non-streaming model call. THROWS on transport/timeout/non-200 so the
 * calling loop can catch + return loopFail (clean error trace). Temperature
 * defaults higher than triage (loops benefit from a little variation), but
 * callers that need determinism pass temperature: 0.
 */
export async function loopModelCall(
  model: string,
  system: string,
  user: string,
  opts: { numPredict?: number; timeoutMs?: number; temperature?: number } = {}
): Promise<string> {
  if (!model) throw new Error("no model bound for this loop");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        // Background loop runner — release VRAM fast (keep-alive coordination).
        keep_alive: KEEP_ALIVE_BACKGROUND,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: {
          temperature: opts.temperature ?? 0.4,
          num_predict: opts.numPredict ?? 512,
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status}: ${t.slice(0, 160)}`);
    }
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first JSON object/array out of a model reply (lenient). */
export function extractJson<T = unknown>(text: string): T | null {
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };
  const obj = text.match(/\{[\s\S]*\}/);
  const arr = text.match(/\[[\s\S]*\]/);
  // Prefer whichever appears first.
  if (obj && arr) {
    return text.indexOf(obj[0]) < text.indexOf(arr[0])
      ? tryParse(obj[0]) ?? tryParse(arr[0])
      : tryParse(arr[0]) ?? tryParse(obj[0]);
  }
  if (obj) return tryParse(obj[0]);
  if (arr) return tryParse(arr[0]);
  return null;
}

export type { LoopId, LoopResult, LoopTrigger };
