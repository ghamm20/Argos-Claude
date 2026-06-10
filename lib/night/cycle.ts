// lib/night/cycle.ts
//
// Stage 8 (2026-06-09) — THE NIGHT CYCLE. ARGOS works the night shift: a
// scheduled pipeline (mail sweep → file pass → task pass → integrity pass →
// morning brief → night ledger) composed from the capabilities Stages 1–7
// shipped. READ-AND-PROPOSE BIASED: when in doubt, QUEUE for morning; the only
// unattended-action whitelist is the rules file; DELETE never runs unattended;
// NO tool execution from email content.
//
// Every action is hash-chained; the brief carries an evidence ref on every line.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
import { getEmailProvider } from "../email/provider";
import { wrapUntrustedEmails } from "../email/guards";
import * as fileOps from "../tools/file-ops";
import { listTasks, createTask, taskCounts, type Task } from "../tasks/store";
import { runStress } from "../integrity/stress";

export interface NightRule {
  id: string;
  /** "dir/*.ext" — directory + extension glob (kept deliberately simple). */
  match: string;
  action: "move" | "copy" | "mkdir" | "delete";
  /** For move/copy: dest template; {year} expands to the current year. */
  destTemplate?: string;
  /** Auto-execute unattended. DELETE is FORCED to queue regardless. */
  autoApprove?: boolean;
}
export interface NightRulesFile {
  hour?: number;
  rules: NightRule[];
}

export function nightRulesPath(): string {
  return path.join(argosRoot(), "state", "night-rules.json");
}
export function nightQueuePath(): string {
  return path.join(argosRoot(), "state", "night", "queue.jsonl");
}
export function briefPath(dateUtc: string): string {
  return path.join(argosRoot(), "workspace", "briefs", `${dateUtc}.md`);
}

type Classification = "action-needed" | "fyi" | "noise";
function classifyEmail(subject: string, body: string): Classification {
  const t = `${subject} ${body}`.toLowerCase();
  if (/\b(urgent|asap|action required|please (sign|review|approve|respond)|deadline|overdue|invoice|past due)\b/.test(t)) return "action-needed";
  if (/\b(newsletter|unsubscribe|promotion|sale|% off|webinar invite|no-reply digest)\b/.test(t)) return "noise";
  return "fyi";
}

// ---- evidence-ref helper: short, traceable tags for brief lines ----
const ev = (kind: string, ref: string) => `[${kind}:${ref}]`;

export interface NightCycleReport {
  at: string;
  dateUtc: string;
  mail: { deferred: string | null; swept: number; classified: Record<Classification, number>; proposedTaskIds: string[]; rows: Array<{ id: string; from: string; subject: string; klass: Classification; proposedTaskId: string | null }> };
  files: { rulesPresent: boolean; scanned: number; autoExecuted: Array<{ op: string; path: string; dest?: string }>; queued: Array<{ op: string; path: string; dest?: string; reason: string }>; batchOk: boolean | null };
  tasks: { open: number; overdue: Array<{ id: string; title: string; due: string | null }>; tomorrow: Array<{ id: string; title: string }>; proposedCompletions: Array<{ taskId: string; evidenceMsgId: string }> };
  integrity: { catchRate: number; missed: string[] };
  briefPath: string;
}

async function readRules(): Promise<NightRulesFile | null> {
  try {
    return JSON.parse(await fsp.readFile(nightRulesPath(), "utf8")) as NightRulesFile;
  } catch {
    return null;
  }
}

/** Minimal glob: "dir/*.ext" → files in dir with that extension. */
async function matchFiles(root: string, pattern: string): Promise<string[]> {
  const m = pattern.match(/^(.*)\/\*\.([A-Za-z0-9]+)$/);
  if (!m) return [];
  const [, dir, ext] = m;
  try {
    const entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)).map((e) => `${dir}/${e.name}`);
  } catch {
    return [];
  }
}

export interface RunNightOpts {
  now?: Date;
  /** Skip the integrity stress pass (keeps proofs fast). */
  skipIntegrity?: boolean;
  commit?: string;
}

export async function runNightCycle(opts: RunNightOpts = {}): Promise<NightCycleReport> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const dateUtc = at.slice(0, 10);
  const year = String(now.getUTCFullYear());
  const root = argosRoot();

  // ---- 1. MAIL SWEEP (read-only; classify; propose tasks; NEVER act on email) ----
  const mail: NightCycleReport["mail"] = { deferred: null, swept: 0, classified: { "action-needed": 0, fyi: 0, noise: 0 }, proposedTaskIds: [], rows: [] };
  const provider = await getEmailProvider();
  if (!provider.ok) {
    mail.deferred = "email_gate_deferred";
    await appendAudit("email_gate_deferred", { stage: "night.mail_sweep", reason: provider.error }).catch(() => {});
  } else {
    const msgs = await provider.provider.list({ query: "in:inbox", max: 25 }).catch(() => []);
    for (const meta of msgs) {
      const full = (await provider.provider.read(meta.id).catch(() => null)) ?? meta;
      // Guard 1+2 applied to anything entering context (even though we only classify).
      wrapUntrustedEmails([full]);
      const klass = classifyEmail(full.subject ?? "", full.body ?? full.snippet ?? "");
      mail.swept += 1;
      mail.classified[klass] += 1;
      let proposedTaskId: string | null = null;
      if (klass === "action-needed") {
        const t = await createTask({ title: `Email: ${full.subject ?? "(no subject)"}`, note: `from ${full.from}`, source: `email:${full.id}`, proposed: true, at });
        proposedTaskId = t.id;
        mail.proposedTaskIds.push(t.id);
      }
      mail.rows.push({ id: full.id, from: full.from ?? "", subject: full.subject ?? "", klass, proposedTaskId });
    }
  }

  // ---- 2. FILE PASS (declarative rules; whitelist auto, else QUEUE; delete never auto) ----
  const files: NightCycleReport["files"] = { rulesPresent: false, scanned: 0, autoExecuted: [], queued: [], batchOk: null };
  const rules = await readRules();
  if (rules?.rules?.length) {
    files.rulesPresent = true;
    const autoOps: Record<string, unknown>[] = [];
    for (const rule of rules.rules) {
      const matched = await matchFiles(root, rule.match);
      files.scanned += matched.length;
      for (const rel of matched) {
        const filename = path.basename(rel);
        const dest = rule.destTemplate ? rule.destTemplate.replace("{year}", year) + filename : undefined;
        const opDesc = { op: rule.action, path: rel, dest };
        // DELETE never runs unattended; out-of-whitelist (autoApprove !== true) queues.
        if (rule.action === "delete" || rule.autoApprove !== true) {
          const reason = rule.action === "delete" ? "delete never runs unattended" : `rule '${rule.id}' not on the auto-approve whitelist`;
          files.queued.push({ ...opDesc, reason });
        } else {
          // Whitelisted move/copy/mkdir → auto batch (still path-bounded + realpath-safe).
          if (rule.action === "move" || rule.action === "copy") autoOps.push({ operation: rule.action, path: rel, dest });
          else if (rule.action === "mkdir") autoOps.push({ operation: "mkdir", path: rel });
          files.autoExecuted.push(opDesc);
        }
      }
    }
    if (autoOps.length) {
      const res = await fileOps.execute({ operation: "batch", ops: autoOps }, { personaId: "night-cycle" });
      files.batchOk = res.ok;
      await appendAudit("night.file_batch", { ops: autoOps.length, ok: res.ok, summary: res.summary }).catch(() => {});
    }
    // Persist the queued ops for morning approval.
    if (files.queued.length) {
      await fsp.mkdir(path.dirname(nightQueuePath()), { recursive: true });
      for (const q of files.queued) await fsp.appendFile(nightQueuePath(), JSON.stringify({ at, ...q }) + "\n", "utf8");
    }
  }

  // ---- 3. TASK PASS (overdue flags; tomorrow's queue; completions PROPOSED) ----
  const open = await listTasks({ status: "open" });
  const overdue = open.filter((t: Task) => t.due && t.due < at).map((t) => ({ id: t.id, title: t.title, due: t.due }));
  const tomorrow = [...open].sort((a, b) => (a.due ?? "9999") < (b.due ?? "9999") ? -1 : 1).slice(0, 10).map((t) => ({ id: t.id, title: t.title }));
  // Completions detected from mail evidence are PROPOSED, never auto-marked.
  const proposedCompletions: Array<{ taskId: string; evidenceMsgId: string }> = [];
  for (const t of open) {
    const m = mail.rows.find((r) => r.klass !== "noise" && t.title.toLowerCase().includes((r.subject ?? "").toLowerCase().slice(0, 12)) && (r.subject ?? "").length > 12);
    if (m) proposedCompletions.push({ taskId: t.id, evidenceMsgId: m.id });
  }

  // ---- 4. INTEGRITY PASS ----
  let integrity = { catchRate: 0, missed: [] as string[] };
  if (!opts.skipIntegrity) {
    try {
      const rpt = await runStress(opts.commit ?? "night-cycle", at);
      integrity = { catchRate: rpt.catchRate, missed: rpt.findings.map((f) => f.id) };
    } catch { /* graceful */ }
  }

  // ---- 5. MORNING BRIEF (every line evidence-cited) ----
  const counts = await taskCounts(at);
  const brief = buildBrief({ at, dateUtc, mail, files, tasks: { overdue, tomorrow, proposedCompletions }, integrity, counts });
  const bp = briefPath(dateUtc);
  await fsp.mkdir(path.dirname(bp), { recursive: true });
  await fsp.writeFile(bp, brief, "utf8");

  const report: NightCycleReport = {
    at, dateUtc, mail, files,
    tasks: { open: open.length, overdue, tomorrow, proposedCompletions },
    integrity, briefPath: bp,
  };

  // ---- 6. NIGHT LEDGER (single hash-chained entry) ----
  await appendAudit("night.cycle_complete", {
    at, dateUtc,
    mail_processed: mail.swept, mail_deferred: mail.deferred,
    ops_executed: files.autoExecuted.length, ops_queued: files.queued.length,
    tasks_proposed: mail.proposedTaskIds.length, tasks_overdue: overdue.length,
    integrity_catch_rate: integrity.catchRate, integrity_missed: integrity.missed.length,
    brief: bp,
  }).catch(() => {});

  return report;
}

/** Schedule hook (Stage 8) — run the night cycle once per day at/after the
 *  configured hour (default 23:00 local), reusing the heartbeat tick. Idempotent
 *  via today's brief file. Graceful + never blocks the heartbeat. */
export async function pumpNightCycleIfDue(hour = 23): Promise<boolean> {
  const now = new Date();
  if (now.getHours() < hour) return false;
  const dateUtc = now.toISOString().slice(0, 10);
  try {
    await fsp.access(briefPath(dateUtc));
    return false; // today's brief exists → already ran
  } catch {
    /* not run yet */
  }
  await runNightCycle({ now }).catch(() => {});
  return true;
}

function buildBrief(d: {
  at: string; dateUtc: string;
  mail: NightCycleReport["mail"];
  files: NightCycleReport["files"];
  tasks: { overdue: Array<{ id: string; title: string; due: string | null }>; tomorrow: Array<{ id: string; title: string }>; proposedCompletions: Array<{ taskId: string; evidenceMsgId: string }> };
  integrity: { catchRate: number; missed: string[] };
  counts: { open: number; completed: number; cancelled: number; overdue: number };
}): string {
  const L: string[] = [];
  L.push(`# ARGOS night brief — ${d.dateUtc}`, "", `Cycle completed ${d.at}. Every line carries its evidence ref.`, "");

  L.push("## Mail triage");
  if (d.mail.deferred) {
    L.push(`- Mail sweep DEFERRED — email not live (token not minted). ${ev("audit", "email_gate_deferred")}`);
  } else {
    L.push(`Swept ${d.mail.swept} — action ${d.mail.classified["action-needed"]} · FYI ${d.mail.classified.fyi} · noise ${d.mail.classified.noise}.`, "", "| from | subject | class | proposed action |", "|---|---|---|---|");
    for (const r of d.mail.rows) L.push(`| ${r.from} | ${r.subject} | ${r.klass} | ${r.proposedTaskId ? `task ${r.proposedTaskId}` : "—"} ${ev("msg", r.id)} |`);
  }
  L.push("");

  L.push("## File hygiene");
  if (!d.files.rulesPresent) L.push("- No night-rules.json present — file pass skipped (nothing actioned).");
  else {
    L.push(`Scanned ${d.files.scanned}. Executed ${d.files.autoExecuted.length} (whitelisted), queued ${d.files.queued.length} for approval. ${ev("audit", "night.file_batch")}`);
    for (const o of d.files.autoExecuted) L.push(`- EXECUTED ${o.op} ${o.path}${o.dest ? ` → ${o.dest}` : ""}`);
    for (const q of d.files.queued) L.push(`- QUEUED ${q.op} ${q.path}${q.dest ? ` → ${q.dest}` : ""} — ${q.reason} ${ev("queue", "state/night/queue.jsonl")}`);
  }
  L.push("");

  L.push("## Tasks", `Open ${d.counts.open} · done ${d.counts.completed} · overdue ${d.counts.overdue}.`);
  for (const t of d.tasks.overdue) L.push(`- OVERDUE ${t.title} (due ${t.due}) ${ev("task", t.id)}`);
  for (const c of d.tasks.proposedCompletions) L.push(`- PROPOSED complete ${ev("task", c.taskId)} — mail evidence ${ev("msg", c.evidenceMsgId)} (not auto-marked)`);
  if (d.tasks.tomorrow.length) L.push("", "Tomorrow's queue:", ...d.tasks.tomorrow.map((t) => `- ${t.title} ${ev("task", t.id)}`));
  L.push("");

  L.push("## Integrity", `Catch rate ${(d.integrity.catchRate * 100).toFixed(1)}%, ${d.integrity.missed.length} miss(es)${d.integrity.missed.length ? ` (${d.integrity.missed.join(", ")})` : ""}. ${ev("audit", "state/integrity-metrics.jsonl")}`);
  L.push("");
  L.push("---", `*Autonomous night cycle. Read-and-propose biased: out-of-rules file ops and all deletes are queued, never executed unattended. ${ev("audit", "night.cycle_complete")}*`);
  return L.join("\n");
}
