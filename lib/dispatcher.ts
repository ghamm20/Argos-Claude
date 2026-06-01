// lib/dispatcher.ts
//
// Phase 11 Dispatcher (2026-05-31) — unified event dispatcher.
//
// OpenClaw-inspired (studied, NOT installed): an event arrives → the
// dispatcher classifies it → routes to the correct persona → the
// persona acts (over Ollama) → the result is logged to a Markdown
// memory layer → a Pushover alert fires if actionable, silent if not.
//
// This phase wires together three existing ARGOS subsystems rather than
// re-implementing them:
//   - lib/persona-router.ts  (classifyByKeyword) — content classification
//   - lib/research/alerts.ts (pushoverSend)       — alert delivery
//   - the scheduler's atomic temp+fsync+rename    — durable state writes
// and adds two OpenClaw patterns natively:
//   - Markdown memory  (memory/MEMORY.md + memory/YYYY-MM-DD.md)
//   - Markdown skills  (skills/<name>.md injected into the prompt)
//
// Doctrine:
//   - GRACEFUL. Ollama down → the event is logged, the dispatch is
//     skipped, and ARGOS never crashes (status "error").
//   - ATOMIC. All memory + state writes use temp-file + fsync + rename.
//   - SUGGESTION/ALERT ONLY. The dispatcher never changes the operator's
//     active persona; it routes events, not the UI.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import { getOllamaBase } from "./ollama-config";
import { PERSONA_BY_ID, type PersonaId } from "./personas";
import { classifyByKeyword } from "./persona-router";
import { pushoverSend } from "./research/alerts";

// ----- constants -----

/** Marker a persona returns when an event needs no operator attention. */
export const DISPATCH_OK_MARKER = "DISPATCH_OK";

const ACTION_TIMEOUT_MS = 30_000;

// ----- types -----

export interface DispatchEvent {
  /** Event category — drives routing. Free-form; common values:
   *  security|threat, research|intel, ops|operational|scheduling,
   *  comms|relationship, heartbeat, manual, general. */
  type: string;
  /** The event payload the persona reasons about. */
  content: string;
  /** Where the event came from (heartbeat, manual, webhook, …). */
  source: string;
}

export type DispatchStatus = "ok" | "actionable" | "error";

export interface DispatchAlertPayload {
  title: string;
  message: string;
  fired: boolean;
  reason: string;
}

export interface DispatchResult {
  at: string; // ISO timestamp
  source: string;
  eventType: string;
  persona: PersonaId;
  skillUsed: string | null; // skill filename, or null if none/missing
  status: DispatchStatus;
  responseSnippet: string | null;
  alert: DispatchAlertPayload | null;
  memoryWritten: boolean;
  reason: string;
  durationMs: number;
}

interface DispatchState {
  lastEventAt: string | null;
  lastType: string | null;
  lastPersona: PersonaId | null;
  lastStatus: DispatchStatus | null;
  count: number;
  byPersona: Partial<Record<PersonaId, number>>;
  last: DispatchResult | null;
}

const EMPTY_STATE: DispatchState = {
  lastEventAt: null,
  lastType: null,
  lastPersona: null,
  lastStatus: null,
  count: 0,
  byPersona: {},
  last: null,
};

// ----- paths -----

export function memoryDir(): string {
  return path.join(argosRoot(), "memory");
}
export function memoryFilePath(): string {
  return path.join(memoryDir(), "MEMORY.md");
}
export function dailyLogPath(dateStamp: string): string {
  return path.join(memoryDir(), `${dateStamp}.md`);
}
export function skillsDir(): string {
  return path.join(argosRoot(), "skills");
}
export function dispatcherStatePath(): string {
  return path.join(argosRoot(), "state", "dispatcher-state.json");
}

// ----- routing -----

// Persona → skill file. Juniper (comms) has no dedicated skill in the
// starter set; it dispatches without one.
const PERSONA_SKILL: Partial<Record<PersonaId, string>> = {
  bartimaeus: "security-triage",
  sage: "research-synthesis",
  bobby: "ops-dispatch",
};

// Explicit event-type → persona map (directive routing).
function personaForType(type: string): PersonaId | null {
  const t = type.toLowerCase().trim();
  if (/\b(security|threat|breach|attack|vuln|intrusion|incident)\b/.test(t))
    return "bartimaeus";
  if (/\b(research|intel|intelligence|study|survey)\b/.test(t)) return "sage";
  if (/\b(ops|operational|operations|scheduling|schedule|deploy|infra|devops)\b/.test(t))
    return "bobby";
  if (/\b(comms|communication|relationship|social|message|email|reply)\b/.test(t))
    return "juniper";
  return null;
}

// Domain keyword overlay for generic event types — content-based.
const DOMAIN_KW: Array<{ persona: PersonaId; re: RegExp }> = [
  {
    persona: "bartimaeus",
    re: /\b(threat|breach|attack|vulnerab|cve|intrusion|malware|phish|exploit|unauthorized|credential|firewall|compromise|security)\b/i,
  },
  {
    persona: "sage",
    re: /\b(research|summari[sz]e|synthesi[sz]e|intel|trends?|papers?|study|sources?|citation|analy[sz]e the)\b/i,
  },
  {
    persona: "bobby",
    re: /\b(deploy|server|disk|cpu|memory|uptime|cron|schedule|backup|build|pipeline|service|restart|provision|capacity|ops)\b/i,
  },
  {
    persona: "juniper",
    re: /\b(reply|message|email|meeting|call|relationship|reach out|follow up|thank|apolog|introduc)\b/i,
  },
];

/**
 * Classify an event to a persona. Explicit type wins; else a domain
 * keyword overlay; else the persona-router's keyword classifier; else
 * the directive default (Bartimaeus). Pure/total — never throws.
 */
export function classifyDispatchPersona(
  type: string,
  content: string
): { persona: PersonaId; basis: string } {
  const byType = personaForType(type);
  if (byType) return { persona: byType, basis: `type:${type}` };

  const text = `${type} ${content}`;
  for (const { persona, re } of DOMAIN_KW) {
    if (re.test(text)) return { persona, basis: "domain-keyword" };
  }

  try {
    const r = classifyByKeyword(content);
    if (r.recommended) return { persona: r.recommended, basis: "persona-router" };
  } catch {
    /* router is total, but belt + braces */
  }
  // Default fallback per directive.
  return { persona: "bartimaeus", basis: "default" };
}

/** Classify a persona's response: DISPATCH_OK ⇒ suppress; else actionable. */
export function classifyDispatchResponse(reply: string): "ok" | "actionable" {
  const trimmed = (reply ?? "").trim();
  if (trimmed.length === 0) return "ok";
  const upper = trimmed.toUpperCase();
  if (upper === DISPATCH_OK_MARKER) return "ok";
  if (trimmed.length <= 64 && upper.includes(DISPATCH_OK_MARKER)) return "ok";
  return "actionable";
}

// ----- skills -----

/** Load a skill Markdown file from ARGOS_ROOT/skills. Graceful: a
 *  missing skill returns null and the dispatch proceeds without it. */
async function loadSkill(skillName: string | undefined): Promise<{ name: string; body: string } | null> {
  if (!skillName) return null;
  try {
    const body = await fsp.readFile(path.join(skillsDir(), `${skillName}.md`), "utf8");
    return { name: skillName, body };
  } catch {
    return null;
  }
}

// ----- the persona action (Ollama) -----

function dispatchSystemPrompt(
  persona: PersonaId,
  event: DispatchEvent,
  skill: { name: string; body: string } | null
): string {
  const name = PERSONA_BY_ID[persona]?.name ?? persona;
  const parts = [
    `You are ${name}, acting on a dispatched "${event.type}" event for a security operator.`,
    "Review the event below. Decide whether it needs the operator's attention RIGHT NOW.",
    `If nothing is needed, reply with EXACTLY this and nothing else: ${DISPATCH_OK_MARKER}`,
    "If action is needed, reply with a short, specific, actionable summary (what + why + next step). No preamble.",
    "Be conservative — only flag genuinely actionable, time-sensitive items.",
  ];
  if (skill) {
    parts.push("", `--- SKILL: ${skill.name} ---`, skill.body.trim(), "--- END SKILL ---");
  }
  return parts.join("\n");
}

async function actWithPersona(
  persona: PersonaId,
  event: DispatchEvent,
  skill: { name: string; body: string } | null
): Promise<string> {
  const model = PERSONA_BY_ID[persona]?.model;
  if (!model) throw new Error(`persona ${persona} has no model`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: dispatchSystemPrompt(persona, event, skill) },
          { role: "user", content: `[${event.type} event from ${event.source}]\n${event.content}` },
        ],
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 256 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status}: ${errText.slice(0, 200)}`);
    }
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// ----- markdown memory (atomic append) -----

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Atomically append `entry` to `file`. Read-modify-write with the
 * scheduler's temp+fsync+rename discipline: a reader always sees the
 * old or the new whole file, never a partial write, even on a yank.
 */
async function atomicAppend(file: string, entry: string): Promise<void> {
  await ensureDir(path.dirname(file));
  let existing = "";
  try {
    existing = await fsp.readFile(file, "utf8");
  } catch {
    /* new file */
  }
  const next = existing + entry;
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(next, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function memoryEntry(result: DispatchResult, event: DispatchEvent): string {
  const time = result.at.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const name = PERSONA_BY_ID[result.persona]?.name ?? result.persona;
  const lines: string[] = [
    `### ${time} — [${event.type}] → ${name}  (${result.status})`,
    `- **source:** ${event.source}`,
    `- **skill:** ${result.skillUsed ?? "(none)"}`,
    `- **event:** ${event.content.replace(/\s+/g, " ").slice(0, 400)}`,
  ];
  if (result.responseSnippet) {
    lines.push(`- **response:** ${result.responseSnippet.replace(/\s+/g, " ").slice(0, 600)}`);
  }
  if (result.alert) {
    lines.push(
      `- **alert:** ${result.alert.fired ? "FIRED" : "not fired"} — ${result.alert.title} (${result.alert.reason})`
    );
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

/** Ensure MEMORY.md has its long-term header on first creation. */
async function ensureMemoryHeader(): Promise<void> {
  const file = memoryFilePath();
  try {
    await fsp.access(file);
  } catch {
    await atomicAppend(
      file,
      [
        "# ARGOS — MEMORY.md",
        "",
        "> Long-term dispatcher memory (OpenClaw daily-log pattern).",
        "> Append-only — never overwritten. Each entry is date+time stamped.",
        "> Per-day detail lives in the sibling `YYYY-MM-DD.md` files.",
        "",
        "",
      ].join("\n")
    );
  }
}

/** Ensure a daily log has its day header on first creation. */
async function ensureDailyHeader(dateStamp: string): Promise<void> {
  const file = dailyLogPath(dateStamp);
  try {
    await fsp.access(file);
  } catch {
    await atomicAppend(file, `# ARGOS daily log — ${dateStamp}\n\n`);
  }
}

/** Write a dispatch result to both MEMORY.md and the daily log. */
async function writeMemory(result: DispatchResult, event: DispatchEvent): Promise<boolean> {
  try {
    const dateStamp = result.at.slice(0, 10); // YYYY-MM-DD
    await ensureMemoryHeader();
    await ensureDailyHeader(dateStamp);
    const entry = memoryEntry(result, event);
    await atomicAppend(memoryFilePath(), entry);
    await atomicAppend(dailyLogPath(dateStamp), entry);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[dispatcher] memory write failed (non-fatal): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return false;
  }
}

// ----- state -----

async function readState(): Promise<DispatchState> {
  try {
    const raw = await fsp.readFile(dispatcherStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DispatchState>;
    return { ...EMPTY_STATE, ...parsed, byPersona: { ...(parsed.byPersona ?? {}) } };
  } catch {
    return { ...EMPTY_STATE, byPersona: {} };
  }
}

async function writeState(s: DispatchState): Promise<void> {
  const final = dispatcherStatePath();
  await ensureDir(path.dirname(final));
  const tmp = `${final}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(s, null, 2), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
}

// ----- the dispatch -----

/**
 * Dispatch one event. Total/graceful — never throws.
 *
 * opts.responseOverride — TEST HOOK: bypass the Ollama call and use this
 *   string as the persona's response (lets the smoke test the OK-suppress
 *   and actionable-alert paths deterministically without a live model).
 */
export async function dispatchEvent(
  event: DispatchEvent,
  opts: { responseOverride?: string } = {}
): Promise<DispatchResult> {
  const start = Date.now();
  const at = new Date().toISOString();
  const type = typeof event?.type === "string" && event.type.trim() ? event.type.trim() : "general";
  const content = typeof event?.content === "string" ? event.content : "";
  const source = typeof event?.source === "string" && event.source.trim() ? event.source.trim() : "unknown";
  const ev: DispatchEvent = { type, content, source };

  const { persona, basis } = classifyDispatchPersona(type, content);
  const skillName = PERSONA_SKILL[persona];

  const base = (
    status: DispatchStatus,
    reason: string,
    extra: Partial<DispatchResult> = {}
  ): DispatchResult => ({
    at,
    source,
    eventType: type,
    persona,
    skillUsed: null,
    status,
    responseSnippet: null,
    alert: null,
    memoryWritten: false,
    reason,
    durationMs: Date.now() - start,
    ...extra,
  });

  let result: DispatchResult;
  try {
    const skill = await loadSkill(skillName);

    // 1) Persona acts (model call, or the test override).
    let reply: string;
    if (opts.responseOverride !== undefined) {
      reply = opts.responseOverride;
    } else {
      reply = await actWithPersona(persona, ev, skill);
    }
    const snippet = reply.trim().slice(0, 280) || null;
    const decision = classifyDispatchResponse(reply);

    if (decision === "ok") {
      result = base("ok", `DISPATCH_OK — nothing actionable (route: ${basis})`, {
        skillUsed: skill?.name ?? null,
        responseSnippet: snippet,
      });
    } else {
      // 2) Actionable → build + send the alert (reuses pushoverSend;
      //    no-ops cleanly without Pushover creds).
      const name = PERSONA_BY_ID[persona]?.name ?? persona;
      const title = `⚠ ARGOS Dispatch — ${name} (${type})`;
      const message = reply.trim().length > 0 ? reply.trim() : "Dispatcher flagged an item (no detail).";
      const delivery = await pushoverSend({ title, message, priority: "0" }).catch((e) => ({
        sent: false,
        reason: `send threw: ${e instanceof Error ? e.message : String(e)}`,
      }));
      result = base("actionable", `actionable (route: ${basis})`, {
        skillUsed: skill?.name ?? null,
        responseSnippet: snippet,
        alert: { title, message, fired: delivery.sent, reason: delivery.reason },
      });
    }
  } catch (e) {
    // Graceful: Ollama down / any failure → clean error result. The event
    // is still logged to memory below so nothing is lost.
    // eslint-disable-next-line no-console
    console.warn(
      `[dispatcher] dispatch error (degraded, ARGOS unaffected): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    result = base("error", `dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3) Always log to Markdown memory (even on error/ok) so the event
  //    trail is durable.
  result.memoryWritten = await writeMemory(result, ev);

  // 4) Persist dispatcher state for the HUD / status endpoint.
  try {
    const state = await readState();
    state.lastEventAt = result.at;
    state.lastType = result.eventType;
    state.lastPersona = result.persona;
    state.lastStatus = result.status;
    state.count += 1;
    state.byPersona[result.persona] = (state.byPersona[result.persona] ?? 0) + 1;
    state.last = result;
    await writeState(state);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[dispatcher] state persist failed (non-fatal): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  return result;
}

/** Diagnostics for /api/dispatch (GET) + the HUD. */
export async function getDispatcherStatus(): Promise<{
  lastEventAt: string | null;
  lastType: string | null;
  lastPersona: PersonaId | null;
  lastStatus: DispatchStatus | null;
  count: number;
  byPersona: Partial<Record<PersonaId, number>>;
  last: DispatchResult | null;
  memoryFile: string;
  skillsDir: string;
}> {
  const state = await readState();
  return {
    lastEventAt: state.lastEventAt,
    lastType: state.lastType,
    lastPersona: state.lastPersona,
    lastStatus: state.lastStatus,
    count: state.count,
    byPersona: state.byPersona,
    last: state.last,
    memoryFile: memoryFilePath(),
    skillsDir: skillsDir(),
  };
}
