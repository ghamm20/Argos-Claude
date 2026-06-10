// lib/brief/coo.ts
//
// Stage 13 (2026-06-09) — the COO brief. An EXECUTIVE, decision-focused brief
// (distinct from the Stage-8 night ops brief): the inbox is bucketed into COO
// categories (decisions / escalations / financial / relationships) and joined
// with open + overdue tasks into a recommended action queue — what a Chief
// Operating Officer reads first.
//
// INTERPRETATION NOTE: the verbatim Stage-13 spec was not in context; this is a
// minimal defensible build composing the email tool + task ledger, flagged for
// morning refinement.
//
// Generated DETERMINISTICALLY (no model call) — so email content never leaves
// the box. Email runs against the synthetic fixture mailbox; no token →
// email_gate_deferred + a tasks-only brief.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";
import { appendAudit } from "../audit";
import { getEmailProvider } from "../email/provider";
import { wrapUntrustedEmails } from "../email/guards";
import { listTasks } from "../tasks/store";

export type CooBucket = "escalation" | "decision" | "financial" | "relationship" | "fyi";

function bucket(subject: string, body: string): CooBucket {
  const t = `${subject} ${body}`.toLowerCase();
  if (/\b(urgent|asap|overdue|past due|escalat|risk|outage|breach|deadline today)\b/.test(t)) return "escalation";
  if (/\b(invoice|payment|contract|quote|cost|budget|renewal|wire|po\b|purchase order)\b/.test(t)) return "financial";
  if (/\b(sign|approve|decision|decide|authorize|confirm|go\/no-go|review and approve)\b/.test(t)) return "decision";
  if (/\b(intro|meeting|call|client|partner|customer|relationship|follow ?up|thanks)\b/.test(t)) return "relationship";
  return "fyi";
}

export function cooBriefPath(dateUtc: string): string {
  return path.join(argosRoot(), "workspace", "briefs", `coo-${dateUtc}.md`);
}

export interface CooBriefResult {
  at: string;
  dateUtc: string;
  deferred: string | null;
  buckets: Record<CooBucket, Array<{ id: string; from: string; subject: string }>>;
  openTasks: number;
  overdueTasks: number;
  briefPath: string;
}

// Priority order a COO triages in.
const ORDER: CooBucket[] = ["escalation", "decision", "financial", "relationship", "fyi"];

export async function generateCooBrief(opts: { now?: Date } = {}): Promise<CooBriefResult> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const dateUtc = at.slice(0, 10);
  const buckets: CooBriefResult["buckets"] = { escalation: [], decision: [], financial: [], relationship: [], fyi: [] };
  let deferred: string | null = null;

  const provider = await getEmailProvider();
  if (!provider.ok) {
    deferred = "email_gate_deferred";
    await appendAudit("email_gate_deferred", { stage: "coo_brief", reason: provider.error }).catch(() => {});
  } else {
    const msgs = await provider.provider.list({ query: "in:inbox", max: 25 }).catch(() => []);
    for (const meta of msgs) {
      const full = (await provider.provider.read(meta.id).catch(() => null)) ?? meta;
      wrapUntrustedEmails([full]); // guards apply even though we only classify
      const b = bucket(full.subject ?? "", full.body ?? full.snippet ?? "");
      buckets[b].push({ id: full.id, from: full.from ?? "", subject: full.subject ?? "" });
    }
  }

  const open = await listTasks({ status: "open" });
  const overdue = open.filter((t) => t.due && t.due < at);

  const L: string[] = [];
  L.push(`# COO Brief — ${dateUtc}`, "", `Executive view. Decisions and escalations first. Generated ${at}.`, "");
  if (deferred) L.push("> Mailbox not live (token not minted) — inbox section deferred. [audit:email_gate_deferred]", "");
  for (const b of ORDER) {
    const items = buckets[b];
    if (!items.length) continue;
    L.push(`## ${b[0].toUpperCase() + b.slice(1)} (${items.length})`);
    for (const it of items) L.push(`- ${it.subject} — ${it.from} [msg:${it.id}]`);
    L.push("");
  }
  L.push("## Open work", `${open.length} open task(s), ${overdue.length} overdue.`);
  for (const t of overdue) L.push(`- OVERDUE ${t.title} (due ${t.due}) [task:${t.id}]`);
  L.push("");
  L.push("## Recommended action queue (COO triage order)");
  const queue = [...buckets.escalation, ...buckets.decision, ...buckets.financial].slice(0, 8);
  if (queue.length) queue.forEach((q, i) => L.push(`${i + 1}. ${q.subject} [msg:${q.id}]`));
  else L.push("- Nothing requiring executive action in the inbox.");
  L.push("", "---", "*COO brief — email content stays on the box (assembled locally, never sent). [audit:brief.coo_generated]*");

  const bp = cooBriefPath(dateUtc);
  await fsp.mkdir(path.dirname(bp), { recursive: true });
  await fsp.writeFile(bp, L.join("\n"), "utf8");
  await appendAudit("brief.coo_generated", {
    dateUtc, deferred,
    escalations: buckets.escalation.length, decisions: buckets.decision.length,
    financial: buckets.financial.length, relationships: buckets.relationship.length,
    openTasks: open.length, overdueTasks: overdue.length, brief: bp,
  }).catch(() => {});

  return { at, dateUtc, deferred, buckets, openTasks: open.length, overdueTasks: overdue.length, briefPath: bp };
}
