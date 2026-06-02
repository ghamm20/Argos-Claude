// lib/current-facts-detector.ts
//
// Forced-tool grounding for time-sensitive queries (2026-06-02).
//
// THE PROBLEM: asked "who is the president?", Bartimaeus answered from training
// data ("Joe Biden") instead of calling web_search — training data is frozen,
// so any current-fact answer is silently stale.
//
// THE FIX: detect time-sensitive / current-fact queries server-side and FORCE a
// live web_search BEFORE the model generates, injecting the fresh results as
// authoritative context. The model can no longer answer office-holders, "the
// latest X", prices, weather, or "as of 2026" from memory — the current truth
// is already in front of it.
//
// Pure + dependency-free. The chat route owns the actual web_search call; this
// module only decides WHEN to force it and how to frame the result.

export type CurrentFactsCategory =
  | "office-holder"
  | "time-relative"
  | "explicit-year"
  | "price-market"
  | "weather"
  | "news-event"
  | "sports"
  | "datetime";

export interface CurrentFactsDetection {
  isCurrentFacts: boolean;
  category: CurrentFactsCategory | null;
  reason: string;
  /** The query to hand to web_search (lightly cleaned). */
  suggestedQuery: string;
}

// Markers that the query is about the PAST (a historical fact, not a current
// one). If these are present AND no explicit "current" marker is, we do NOT
// force a search — "who was the first president" should not trigger.
const HISTORICAL_RE =
  /\b(was|were|former|ex-|previous(ly)?|used to|in (1\d{3}|20[01]\d)|history of|founded|founding|first (ever|president|ruler)|originally|back in|centuries? ago|ancient)\b/i;

// Explicit "I mean RIGHT NOW" markers — these override the historical guard.
const EXPLICIT_CURRENT_RE =
  /\b(current(ly)?|right now|as of (today|now|this)|today|tonight|this (year|month|week|morning)|these days|nowadays|at the moment|latest|most recent|up[- ]to[- ]date)\b/i;

interface Pattern {
  category: CurrentFactsCategory;
  re: RegExp;
  reason: string;
}

// Each pattern, if matched, marks the query as current-facts. Office-holder and
// the others fire even without an explicit "current" word, because the present
// tense ("who is the president") is inherently a current-fact question.
const PATTERNS: Pattern[] = [
  {
    category: "office-holder",
    re: /\bwho('?s| is| are)\b[^?]*\b(president|vice[- ]president|prime minister|pm|chancellor|premier|monarch|king|queen|pope|ceo|chief executive|governor|mayor|senator|secretary of|head of state|leader|chair(man|woman|person)?)\b/i,
    reason: "asks who currently holds an office/role",
  },
  {
    category: "office-holder",
    re: /\b(president|prime minister|chancellor|ceo|governor|mayor|leader|monarch|king|queen|pope)\s+of\s+[a-z]/i,
    reason: "names a current office/role of an entity",
  },
  {
    category: "time-relative",
    re: EXPLICIT_CURRENT_RE,
    reason: "uses a time-relative marker (current/now/today/latest/…)",
  },
  {
    category: "explicit-year",
    re: /\b(202[4-9]|20[3-9]\d)\b/,
    reason: "references a current/near-future year",
  },
  {
    category: "price-market",
    re: /\b(stock price|share price|market cap|exchange rate|price of|how much (is|does|are)|bitcoin|ethereum|crypto|gas price|interest rate|inflation rate)\b/i,
    reason: "asks about a live price / market figure",
  },
  {
    category: "weather",
    re: /\b(weather|forecast|temperature (in|at|today|right now)|is it (raining|snowing|sunny))\b/i,
    reason: "asks about current weather",
  },
  {
    category: "news-event",
    re: /\b(news|headlines?|breaking|what'?s happening|latest on|update on|did .* (win|happen|announce))\b/i,
    reason: "asks about recent news / events",
  },
  {
    category: "sports",
    re: /\b(score|who won|winner of|champions?|standings|final score|playoffs?|world cup|super bowl)\b/i,
    reason: "asks about a live/recent sports result",
  },
  {
    category: "datetime",
    re: /\b(what (time|day|date) is it|what'?s the (time|date)|today'?s date|current (time|date))\b/i,
    reason: "asks for the current date/time",
  },
];

function cleanQuery(q: string): string {
  return q
    .replace(/^\s*\/(deep|refine|debate|simulate)\b/i, "")
    .replace(/\b(hey |ok |okay )?bart(imaeus)?[,:]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Decide whether a query is time-sensitive enough that the model must NOT answer
 * from training data. Conservative on clearly-historical questions (unless an
 * explicit "current" marker is present).
 */
export function detectCurrentFacts(query: string): CurrentFactsDetection {
  const q = (query ?? "").trim();
  const none: CurrentFactsDetection = {
    isCurrentFacts: false,
    category: null,
    reason: "not time-sensitive",
    suggestedQuery: cleanQuery(q),
  };
  if (!q) return none;

  const explicitCurrent = EXPLICIT_CURRENT_RE.test(q);
  const historical = HISTORICAL_RE.test(q);

  for (const p of PATTERNS) {
    if (!p.re.test(q)) continue;
    // The time-relative pattern IS the explicit-current marker, so it always
    // counts. For the others, a clearly-historical phrasing without a current
    // marker is treated as a past-fact question and NOT forced.
    if (p.category !== "time-relative" && historical && !explicitCurrent) {
      continue;
    }
    return {
      isCurrentFacts: true,
      category: p.category,
      reason: p.reason,
      suggestedQuery: cleanQuery(q),
    };
  }
  return none;
}

/** Minimal shape of the web_search ToolResult we read (data is `unknown`). */
export interface WebSearchResultShape {
  data?: unknown;
  summary?: string;
}

type WebHit = { title?: string; url?: string; snippet?: string };

function extractHits(data: unknown): WebHit[] {
  if (data && typeof data === "object" && "results" in data) {
    const r = (data as { results?: unknown }).results;
    if (Array.isArray(r)) return r as WebHit[];
  }
  return [];
}

/**
 * Frame freshly-retrieved web results as the authoritative, override-training
 * context for a current-facts answer. Injected into Bartimaeus's system prompt
 * BEFORE generation.
 */
export function buildCurrentFactsBlock(
  detection: CurrentFactsDetection,
  search: WebSearchResultShape
): string {
  const results = extractHits(search.data);
  const lines = results.slice(0, 5).map((r, i) => {
    const t = (r.title ?? "").replace(/\s+/g, " ").trim();
    const s = (r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    return `[${i + 1}] ${t}${s ? ` — ${s}` : ""}${r.url ? ` (${r.url})` : ""}`;
  });
  return [
    "CURRENT FACTS — FRESHLY RETRIEVED, AUTHORITATIVE.",
    "",
    `The operator asked a time-sensitive question (${detection.category}). ARGOS`,
    "ran a live web_search just now and the results are below. Your training data",
    "is FROZEN and STALE for this — these results OVERRIDE it. Answer the operator's",
    "question using ONLY these results, in one plain sentence first. Do NOT answer a",
    "current-fact question from memory when results are present. If the results do",
    "not contain the answer, say so plainly — do not fall back to training data.",
    "",
    `Search: ${detection.suggestedQuery}`,
    results.length ? "Results:" : "(no results returned — say you couldn't verify the current fact)",
    ...lines,
  ].join("\n");
}
