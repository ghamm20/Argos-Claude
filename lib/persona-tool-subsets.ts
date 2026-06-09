// lib/persona-tool-subsets.ts — v2.3.11 (Persona Tool Distribution)
//
// Before this, only Bartimaeus had tool awareness; Sage/Bobby/Juniper could
// technically emit tool tags but their prompts never listed tools, so 75% of
// the persona system never acted. This file curates a ROLE-SCOPED tool subset
// per persona. The chat route:
//   1. renders each persona's tool-awareness block from its subset, and
//   2. ENFORCES the subset at execution — a persona emitting a tool outside its
//      subset is rejected (audited, not run), so the distribution is real, not
//      advisory.
//
// Bartimaeus = "*" (all tools — verifier/director, current behavior preserved).
// The others get a curated list. Subsets are intersected with the live registry
// at call time, so a name that doesn't exist yet (or never becomes a tool) is
// silently dropped rather than mis-listed.
//
// Honest gaps vs the v2.3.11 spec (documented, not faked):
//   - Bobby's spec lists `frankfurter_fx` — that tool does not exist until
//     Phase 2 (v2.4.0 financial). It is added to Bobby's subset THERE, where it
//     is actually created. Listing it now would render a tool Bobby can't call.
//   - Bobby + Juniper specs list `memory_audit` — there is no such registry
//     tool. Cross-session memory recall is AUTO-INJECTED into every operator
//     turn by the chat route (Phase 9), so both personas already receive memory
//     context passively; there is nothing to "call". Omitted, not invented.

import type { PersonaId } from "./personas";

/** "*" means every registered tool (resolved against the live registry). */
export const PERSONA_TOOL_SUBSETS: Record<PersonaId, string[] | "*"> = {
  // Verifier / director — keeps all web + integration tools. Unchanged.
  bartimaeus: "*",

  // Research synthesist — knowledge, search, code, document tools.
  sage: [
    // Knowledge
    "wikipedia_search",
    "wikidata_query",
    "arxiv_search",
    "openalex_search",
    "papers_with_code",
    "huggingface_hub",
    "crossref_lookup",
    "pubmed_search",
    // Search
    "chain_search_to_read",
    "web_search",
    "jina_reader",
    "web_crawl",
    // Code
    "github_search",
    "stackexchange_search",
    // Document
    "pdf_extract",
    "doc_generate",
    "csv_analysis",
    // Tier 4 (v2.4.0) — Tennessee environmental + media/documentation.
    "usda_nass",
    "usgs_water",
    "noaa_climate",
    "epa_envirofacts",
    "internet_archive",
    "openlibrary",
    "libretranslate",
  ],

  // Operational triage — fast lookup + ops + data. (`frankfurter_fx` joins in
  // Phase 2 where it is created; `memory_audit` is auto-injected, not a tool.)
  bobby: [
    // Quick lookup
    "wikipedia_search",
    "web_search",
    "chain_search_to_read",
    // Ops
    "file_ops",
    "shell_exec",
    "schedule_query",
    "csv_analysis",
    "tasks", // Stage 2 — task ledger (ungated)
    "email_read", // Stage 3 — read-only email (untrusted content guards)
    // Weather / data
    "open_meteo_weather",
    // Tier 4 (v2.4.0) — security ops + financial (frankfurter_fx promised here).
    "nvd_cve",
    "hibp",
    "federal_register",
    "frankfurter_fx",
    "fred",
  ],

  // Warm communication — comms + light context. (`memory_audit` auto-injected.)
  juniper: [
    "email_draft",
    "twilio_sms",
    "pushover_alert",
    "wikipedia_search",
    "web_search",
  ],
};

/** The persona's tool subset, intersected with the live registry id list. For
 *  bartimaeus ("*") this is simply every registered tool. */
export function toolsForPersona(id: PersonaId, allToolIds: string[]): string[] {
  const subset = PERSONA_TOOL_SUBSETS[id];
  if (subset === "*") return [...allToolIds];
  const live = new Set(allToolIds);
  return subset.filter((t) => live.has(t));
}

/** Is `toolId` permitted for `id`? Used to ENFORCE the subset at execution. */
export function personaHasTool(id: PersonaId, toolId: string, allToolIds: string[]): boolean {
  const subset = PERSONA_TOOL_SUBSETS[id];
  if (subset === "*") return allToolIds.includes(toolId);
  return subset.includes(toolId) && allToolIds.includes(toolId);
}

/** True if the persona is wired for tools at all (non-empty subset). */
export function personaToolsEnabled(id: PersonaId, allToolIds: string[]): boolean {
  return toolsForPersona(id, allToolIds).length > 0;
}
