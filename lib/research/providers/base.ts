// lib/research/providers/base.ts
//
// SearchProvider interface — the common shape all web-search backends
// implement. The chain runner (chain.ts) walks an ordered list of
// providers and returns the first non-empty result set, treating
// transient failures (network errors, 4xx/5xx, empty results) as
// "try the next provider".
//
// Weather (wttr.in) and RSS news are NOT providers — they're
// special-cased in searcher.ts because they map intent-to-endpoint
// directly. Providers cover the web-search shape only (general
// queries, AI updates, crawl topics).

import type { SearchQuery, SearchResult } from "../types";

export interface SearchProvider {
  /** Stable provider id for logs + audit. e.g. "duckduckgo",
   *  "searxng", "brave", "reddit". */
  readonly id: string;
  /** True when this provider is configured + reachable. Cheap
   *  predicate; the chain skips disabled providers without firing
   *  a real network call. SearXNG returns false if no base URL is
   *  set; Brave returns false without an API key. */
  isAvailable(): boolean;
  /** Run a single query against this provider. Implementations MUST
   *  catch their own errors and return [] on failure — never throw.
   *  The chain runner trusts emptiness as the sole failure signal. */
  search(query: SearchQuery): Promise<SearchResult[]>;
}
