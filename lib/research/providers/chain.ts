// lib/research/providers/chain.ts
//
// Web-search fallback chain. Walks providers in order and returns
// the first non-empty result set. Reddit isn't in the chain — it's
// a SUPPLEMENTARY stream the searcher invokes alongside the chain
// (so news/ai queries get both the chain's web result + Reddit's
// community lens).
//
// Order:
//   1. SearXNG (when configured) — operator-sovereign, aggregates
//      70+ engines; preferred when available
//   2. Brave (when API key set) — paid tier, high quality
//   3. DuckDuckGo (always available) — zero-key fallback
//
// The chain ALWAYS includes DDG as the last provider so we never
// fail-over to nothing on a clean install.

import type { SearchProvider } from "./base";
import { duckduckgoProvider } from "./duckduckgo";
import { searxngProvider } from "./searxng";
import { braveProvider } from "./brave";
import type { SearchQuery, SearchResult } from "../types";

/** Build the web-search chain, ordered. Disabled providers are
 *  pruned eagerly so logs reflect what was actually attempted. */
export function buildSearchChain(): SearchProvider[] {
  const chain: SearchProvider[] = [];
  if (searxngProvider.isAvailable()) chain.push(searxngProvider);
  if (braveProvider.isAvailable()) chain.push(braveProvider);
  chain.push(duckduckgoProvider); // always last
  return chain;
}

/**
 * Run the chain. Returns the first non-empty result set along with
 * the provider that produced it. If every provider fails, returns
 * { results: [], provider: null } and logs the chain attempted.
 */
export async function runChain(
  query: SearchQuery
): Promise<{ results: SearchResult[]; provider: string | null }> {
  const chain = buildSearchChain();
  const attempted: string[] = [];
  for (const p of chain) {
    attempted.push(p.id);
    const results = await p.search(query);
    if (results.length > 0) {
      return { results, provider: p.id };
    }
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[research/chain] no provider returned results for "${query.query}" (attempted: ${attempted.join(" → ")})`
  );
  return { results: [], provider: null };
}
