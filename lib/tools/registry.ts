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
// Web Capability TIER 1 (2026-06-02) — keyless knowledge sources.
import * as wikipedia from "./wikipedia";
import * as wikidata from "./wikidata";
import * as arxiv from "./arxiv";
import * as openalex from "./openalex";
import * as papersWithCode from "./papers-with-code";
import * as huggingface from "./huggingface";
import * as crossref from "./crossref";
import * as pubmed from "./pubmed";
import * as gdelt from "./gdelt";
import * as openMeteo from "./open-meteo";
// Web Capability TIER 2 (2026-06-02) — self-hosted search + GitHub + Q&A + SEC.
import * as searxng from "./searxng";
import * as github from "./github";
import * as stackexchange from "./stackexchange";
import * as secEdgar from "./sec-edgar";
// Web Capability TIER 3 (2026-06-02) — ingestion + feeds + chain.
import * as jinaReader from "./jina-reader";
import * as rsshub from "./rsshub";
import * as firecrawlAlt from "./firecrawl-alt";
import * as chainSearchRead from "./chain-search-read";

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
  // ---- web knowledge sources (TIER 1, all safe + keyless) ----
  {
    id: "wikipedia_search",
    name: "Wikipedia",
    description: "Look up an entity/topic on Wikipedia — summary + full article text.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: wikipedia.execute,
  },
  {
    id: "wikidata_query",
    name: "Wikidata",
    description: "Structured entity facts from Wikidata (or a raw SPARQL query).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: wikidata.execute,
  },
  {
    id: "arxiv_search",
    name: "arXiv",
    description: "Search arXiv preprints (AI/ML/physics/math) by query, category, date.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: arxiv.execute,
  },
  {
    id: "openalex_search",
    name: "OpenAlex",
    description: "Open scholarly works — citations, authors, institutions, OA links.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: openalex.execute,
  },
  {
    id: "papers_with_code",
    name: "Papers With Code",
    description: "ML papers linked to code + SOTA benchmarks/leaderboards.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: papersWithCode.execute,
  },
  {
    id: "huggingface_hub",
    name: "Hugging Face Hub",
    description: "Discover models/datasets — downloads, likes, tags, license.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: huggingface.execute,
  },
  {
    id: "crossref_lookup",
    name: "Crossref",
    description: "Academic metadata + DOI resolution (title, authors, journal, year).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: crossref.execute,
  },
  {
    id: "pubmed_search",
    name: "PubMed",
    description: "Medical/biological literature (NCBI) — abstracts + journal metadata.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: pubmed.execute,
  },
  {
    id: "gdelt_events",
    name: "GDELT",
    description: "Global news/event monitoring — recent articles by query/timespan/country.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: gdelt.execute,
  },
  {
    id: "open_meteo_weather",
    name: "Open-Meteo Weather",
    description: "Structured current conditions + forecast for a place (geocodes the name). No key.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: openMeteo.execute,
  },
  // ---- web search + dev + filings (TIER 2, all safe) ----
  {
    id: "searxng_search",
    name: "SearXNG Search",
    description: "Primary general web search (self-hosted SearXNG; DDG fallback).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: searxng.execute,
  },
  {
    id: "github_search",
    name: "GitHub",
    description: "Search repos/code/issues + read a README (uses PAT if configured).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: github.execute,
  },
  {
    id: "stackexchange_search",
    name: "Stack Exchange",
    description: "Search Stack Overflow + sister sites for Q&A with accepted answers.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: stackexchange.execute,
  },
  {
    id: "sec_edgar",
    name: "SEC EDGAR",
    description: "Public company filings (10-K/Q, etc) by query or CIK.",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: secEdgar.execute,
  },
  // ---- ingestion + feeds + chain (TIER 3, all safe) ----
  {
    id: "chain_search_to_read",
    name: "Chain Search→Read",
    description: "DEFAULT for factual queries: searches, ranks, AND reads the top pages (not just snippets).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: chainSearchRead.execute,
  },
  {
    id: "jina_reader",
    name: "Jina Reader",
    description: "Extract a URL's content as clean Markdown (primary page reader).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: jinaReader.execute,
  },
  {
    id: "firecrawl_alt",
    name: "Firecrawl-alt",
    description: "Structured scrape: title/content/links/images/metadata (+ SPA detection).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: firecrawlAlt.execute,
  },
  {
    id: "rsshub_feed",
    name: "RSSHub Feed",
    description: "Read a self-hosted RSSHub route (feeds for sites without native RSS).",
    category: "web",
    requiresApproval: false,
    requiresRestore: false,
    dangerous: false,
    reversible: true,
    execute: rsshub.execute,
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
    description: "Query the live MiroFish-Offline backend (Flask API on :5001). Call with NO params (or just a `query` string) to get the full status snapshot: simulations, projects, and graph entities. Advanced (optional): `graphId` to target one graph's entities, or `endpoint` set to a real path like /api/simulation/list for a raw passthrough.",
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
