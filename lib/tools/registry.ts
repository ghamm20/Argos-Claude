// lib/tools/registry.ts
//
// Tools Phase (2026-06-02) — master registry of Bartimaeus's 18 tools.
//
// Governance per the directive:
//   Safe (immediate):  T1 T2 T3 T4 T6 T7 T13 T14
//   Approval required: T5 T8 T9 T10 T11 T12 T15 T16 T17 T18
//   Restore required:  T15 (delete) + T16
//
// Each tool's execute() lives in its own file; this file wires them to their
// governance flags. The executor reads these flags — nothing bypasses them.

import type { ToolDefinition } from "./types";

import * as webSearch from "./web-search";
import * as webCrawl from "./web-crawl";
import * as deepResearch from "./deep-research";
import * as osint from "./osint";
import * as docGenerate from "./doc-generate";
import * as csvAnalysis from "./csv-analysis";
import * as pdfExtract from "./pdf-extract";
import * as emailDraft from "./email-draft";
import * as pushoverAlert from "./pushover-alert";
import * as twilioSms from "./twilio-sms";
import * as scheduleQuery from "./schedule-query";
import * as incidentReport from "./incident-report";
import * as contractExtract from "./contract-extract";
import * as threatAssess from "./threat-assess";
import * as fileOps from "./file-ops";
import * as shellExec from "./shell-exec";
import * as oculus from "./oculus-integration";
import * as mirofish from "./mirofish-integration";

export const TOOLS: ToolDefinition[] = [
  // ---- web (all safe) ----
  {
    id: "web_search",
    name: "Web Search",
    description: "Search the web (DuckDuckGo) and return the top 5 results.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: webSearch.execute,
  },
  {
    id: "web_crawl",
    name: "Web Crawl / Page Reader",
    description: "Fetch a URL and return its readable text, title, and description.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: webCrawl.execute,
  },
  {
    id: "deep_research",
    name: "Deep Research",
    description: "Run several searches, crawl top sources, and synthesize a report.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: deepResearch.execute,
  },
  {
    id: "osint_lookup",
    name: "OSINT Lookup",
    description: "Open-source recon on a person/company/domain (web + RDAP/WHOIS + news).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: osint.execute,
  },
  // ---- documents ----
  {
    id: "doc_generate",
    name: "Document Generation",
    description: "Write a document (md/txt/json) to ARGOS_ROOT/output/.",
    category: "document",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: true,
    risks: "Writes a new file to disk under ARGOS_ROOT/output. Reversible (delete the file).",
    execute: docGenerate.execute,
  },
  {
    id: "csv_analysis",
    name: "Spreadsheet / CSV Analysis",
    description: "Parse a CSV (vault or path) and report shape, summary, and anomalies.",
    category: "document",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: csvAnalysis.execute,
  },
  {
    id: "pdf_extract",
    name: "PDF Extraction",
    description: "Extract text + structure from a PDF (vault docId or path).",
    category: "document",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: pdfExtract.execute,
  },
  {
    id: "contract_extract",
    name: "Contract Clause Extractor",
    description: "Extract payment/termination/liability/indemnity/IP/non-compete clauses.",
    category: "document",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: contractExtract.execute,
  },
  {
    id: "incident_report",
    name: "Incident Report",
    description: "Generate a formatted incident report and write it to output/.",
    category: "document",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: true,
    risks: "Writes a report file to disk under ARGOS_ROOT/output. Reversible.",
    execute: incidentReport.execute,
  },
  // ---- comms ----
  {
    id: "email_draft",
    name: "Email Draft",
    description: "Draft an email to a file (does NOT send).",
    category: "comms",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: true,
    risks: "Writes a draft file to disk. Does not send. Reversible.",
    execute: emailDraft.execute,
  },
  {
    id: "pushover_alert",
    name: "Pushover Alert",
    description: "Send a push notification to the operator (Pushover→SMS fallback).",
    category: "comms",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: false,
    risks: "Sends an external notification. NOT reversible — it cannot be un-sent.",
    execute: pushoverAlert.execute,
  },
  {
    id: "twilio_sms",
    name: "SMS via Twilio",
    description: "Send an SMS via the configured Twilio account.",
    category: "comms",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: false,
    risks: "Sends an external SMS, possibly billed. NOT reversible.",
    execute: twilioSms.execute,
  },
  // ---- security / live systems ----
  {
    id: "schedule_query",
    name: "Guard Schedule Query",
    description: "Read scheduling data (ARGOS_ROOT/data/schedule/) for coverage + gaps.",
    category: "security",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: true,
    risks: "Queries a live scheduling source (read-only). Reversible.",
    execute: scheduleQuery.execute,
  },
  {
    id: "threat_assess",
    name: "Threat Assessment",
    description: "Produce a calibrated threat assessment (severity/likelihood/confidence).",
    category: "security",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: threatAssess.execute,
  },
  {
    id: "oculus_integration",
    name: "Oculus0Osint",
    description: "Query the Oculus0Osint live entity/camera feed (port 3010).",
    category: "security",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: true,
    risks: "Queries an external live system (read-only). Reversible.",
    execute: oculus.execute,
  },
  {
    id: "mirofish_integration",
    name: "MiroFish",
    description: "Query the MiroFish simulation status + entities (port 3001).",
    category: "security",
    requiresApproval: true,
    requiresRestore: false,
    dangerous: true,
    reversible: true,
    risks: "Queries an external live system (read-only). Reversible.",
    execute: mirofish.execute,
  },
  // ---- system (most dangerous) ----
  {
    id: "file_ops",
    name: "File System Operations",
    description: "read/write/move/list/delete within ARGOS_ROOT (hard boundary).",
    category: "system",
    requiresApproval: fileOps.requiresApproval, // write/move/delete only
    requiresRestore: fileOps.requiresRestore, // delete only
    dangerous: true,
    reversible: true,
    risks:
      "Writes/moves/deletes files inside ARGOS_ROOT only. Deletes create a restore point first.",
    validate: fileOps.validate,
    restorePaths: fileOps.restorePaths,
    execute: fileOps.execute,
  },
  {
    id: "shell_exec",
    name: "Shell Command Execution",
    description: "Run a WHITELISTED diagnostic command (ipconfig, ping, ollama list, …).",
    category: "system",
    requiresApproval: true,
    requiresRestore: true,
    dangerous: true,
    reversible: false,
    risks:
      "Executes a command on this machine. Whitelist-only; non-whitelisted commands are denied. A restore point is created first.",
    validate: shellExec.validate,
    execute: shellExec.execute,
  },
];

const BY_ID: Record<string, ToolDefinition> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t])
);

export function getTool(id: string): ToolDefinition | undefined {
  return BY_ID[id];
}

export interface ToolSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  dangerous: boolean;
  requiresApproval: boolean;
  requiresRestore: boolean;
  reversible: boolean;
}

/** Static summaries for the Tools page + Bart's prompt (no execute fn).
 *  Conditional gov flags are evaluated with empty params for display. */
export function toolSummaries(): ToolSummary[] {
  return TOOLS.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    dangerous: t.dangerous,
    requiresApproval: typeof t.requiresApproval === "function" ? true : t.requiresApproval,
    requiresRestore: typeof t.requiresRestore === "function" ? true : t.requiresRestore,
    reversible: t.reversible,
  }));
}

/** Compact tool list for Bartimaeus's system prompt. */
export function toolListForPrompt(): string {
  return TOOLS.map((t) => {
    const gov =
      typeof t.requiresApproval === "function"
        ? "approval (conditional)"
        : t.requiresApproval
          ? "APPROVAL REQUIRED"
          : "safe";
    return `- ${t.id} — ${t.description} [${gov}]`;
  }).join("\n");
}
