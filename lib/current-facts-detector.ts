// lib/current-facts-detector.ts
//
// Forced-tool grounding for time-sensitive queries (2026-06-02).
//
// THE PROBLEM: asked "who is the president?", Bartimaeus answered from training
// data ("Joe Biden") instead of calling web_search — training data is frozen,
// so any current-fact answer is silently stale. Same for weather, prices, news.
//
// THE FIX: detect time-sensitive / current-fact queries server-side and FORCE a
// live web_search BEFORE the model generates, injecting the fresh results as
// authoritative context. The model can no longer answer office-holders, "the
// latest X", prices, weather, or "as of 2026" from memory.
//
// Weather + typo tolerance (2026-06-02 update): weather is a first-class
// trigger ("temp in", "forecast", "how hot"), the detector is misspelling-
// tolerant via a bounded edit-distance match ("forxast" → "forecast"), and a
// weather query is reshaped to "weather forecast <location> today" so DDG
// actually returns the current conditions instead of junk.
//
// Pure + dependency-free.

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
  /** Alias of isCurrentFacts — should the chat route force a tool call? */
  requiresTool: boolean;
  /** 0..1 confidence that this needs live grounding. */
  confidence: number;
  category: CurrentFactsCategory | null;
  reason: string;
  /** The query to hand to web_search (cleaned; weather-reshaped for weather). */
  suggestedQuery: string;
}

// Markers that the query is about the PAST. If present AND no explicit "current"
// marker is, we do NOT force a search — "who was the first president" must not
// trigger.
const HISTORICAL_RE =
  /\b(was|were|former|ex-|previous(ly)?|used to|in (1\d{3}|20[01]\d)|history of|founded|founding|first (ever|president|ruler)|originally|back in|centuries? ago|ancient)\b/i;

// Explicit "I mean RIGHT NOW" markers — override the historical guard.
const EXPLICIT_CURRENT_RE =
  /\b(current(ly)?|right now|as of (today|now|this)|today|tonight|this (year|month|week|morning)|these days|nowadays|at the moment|latest|most recent|up[- ]to[- ]date)\b/i;

// Explicit weather triggers (incl. "temp", common forecast misspellings).
const WEATHER_RE =
  /\b(weather|forecast|forcast|forxast|forecst|temp|temperature|how (hot|cold|warm)|(is it )?(raining|snowing|sunny|rainy|humid|windy)|degrees|fahrenheit|celsius)\b/i;

interface Pattern {
  category: CurrentFactsCategory;
  re: RegExp;
  reason: string;
  /** base confidence when this pattern matches */
  conf: number;
}

const PATTERNS: Pattern[] = [
  {
    category: "weather",
    re: WEATHER_RE,
    reason: "asks about current weather / temperature / forecast",
    conf: 0.9,
  },
  {
    category: "office-holder",
    re: /\bwho('?s| is| are)\b[^?]*\b(president|vice[- ]president|prime minister|pm|chancellor|premier|monarch|king|queen|pope|ceo|chief executive|governor|mayor|senator|secretary of|head of state|leader|chair(man|woman|person)?)\b/i,
    reason: "asks who currently holds an office/role",
    conf: 0.9,
  },
  {
    category: "office-holder",
    re: /\b(president|prime minister|chancellor|ceo|governor|mayor|leader|monarch|king|queen|pope)\s+of\s+[a-z]/i,
    reason: "names a current office/role of an entity",
    conf: 0.85,
  },
  {
    category: "datetime",
    re: /\b(what (time|day|date) is it|what'?s the (time|date)|today'?s date|current (time|date))\b/i,
    reason: "asks for the current date/time",
    conf: 0.9,
  },
  {
    category: "price-market",
    re: /\b(stock price|share price|market cap|exchange rate|price of|how much (is|does|are)|bitcoin|ethereum|crypto|gas price|interest rate|inflation rate)\b/i,
    reason: "asks about a live price / market figure",
    conf: 0.85,
  },
  {
    category: "news-event",
    re: /\b(news|headlines?|breaking|what'?s happening|latest on|update on|did .* (win|happen|announce))\b/i,
    reason: "asks about recent news / events",
    conf: 0.8,
  },
  {
    category: "sports",
    re: /\b(score|who won|winner of|champions?|standings|final score|playoffs?|world cup|super bowl)\b/i,
    reason: "asks about a live/recent sports result",
    conf: 0.8,
  },
  {
    category: "time-relative",
    re: EXPLICIT_CURRENT_RE,
    reason: "uses a time-relative marker (current/now/today/latest/…)",
    conf: 0.8,
  },
  {
    category: "explicit-year",
    re: /\b(202[4-9]|20[3-9]\d)\b/,
    reason: "references a current/near-future year",
    conf: 0.7,
  },
];

// ----- typo tolerance -----

/** Bounded Levenshtein (returns 3+ when clearly far / length gap > 2). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[n];
}

const WEATHER_VOCAB = ["weather", "forecast", "temperature", "raining", "snowing", "humidity", "sunny"];

/** Fuzzy weather match — catches misspellings like "forxast" → "forecast". */
function fuzzyWeather(q: string): boolean {
  const tokens = q.toLowerCase().replace(/[^a-z]/g, " ").split(/\s+/).filter((w) => w.length >= 5);
  for (const tok of tokens) {
    for (const w of WEATHER_VOCAB) {
      if (editDistance(tok, w) <= 2) return true;
    }
  }
  return false;
}

// ----- query shaping -----

function cleanQuery(q: string): string {
  return q
    .replace(/^\s*\/(deep|refine|debate|simulate)\b/i, "")
    .replace(/\b(hey |ok |okay )?bart(imaeus)?[,:]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const WEATHER_STOP = new Set([
  "what", "whats", "what's", "is", "the", "a", "an", "temp", "temperature", "weather",
  "forecast", "forxast", "forcast", "forecst", "in", "at", "for", "right", "now", "today",
  "tonight", "currently", "current", "also", "how", "hot", "cold", "warm", "raining",
  "snowing", "sunny", "rainy", "humid", "windy", "degrees", "fahrenheit", "celsius",
  "me", "tell", "where", "you", "got", "this", "answer", "snswer", "of", "and", "please",
  "like", "its", "it's", "im", "i'm", "im", "be",
]);

/** Reshape a weather query into one DDG resolves to current conditions: keep the
 *  likely location words, strip filler, prefix "weather forecast", suffix "today". */
function weatherQuery(q: string): string {
  const loc = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !WEATHER_STOP.has(w))
    .join(" ")
    .trim();
  return loc ? `weather forecast ${loc} today` : `weather forecast ${cleanQuery(q)}`;
}

/**
 * Decide whether a query is time-sensitive enough that the model must NOT answer
 * from training data. Conservative on clearly-historical questions (unless an
 * explicit "current" marker is present). Returns a confidence score and, for
 * weather, a reshaped search query.
 */
export function detectCurrentFacts(query: string): CurrentFactsDetection {
  const q = (query ?? "").trim();
  if (!q) {
    return { isCurrentFacts: false, requiresTool: false, confidence: 0, category: null, reason: "empty", suggestedQuery: "" };
  }

  const explicitCurrent = EXPLICIT_CURRENT_RE.test(q);
  const historical = HISTORICAL_RE.test(q);

  // Collect every matching pattern (so we can take the strongest signal + boost
  // when a category co-occurs with an explicit "right now").
  const matches: Pattern[] = [];
  for (const p of PATTERNS) {
    if (!p.re.test(q)) continue;
    if (p.category !== "time-relative" && historical && !explicitCurrent) continue;
    matches.push(p);
  }
  // Typo-tolerant weather fallback (e.g. "forxast" the regex missed).
  if (!matches.some((m) => m.category === "weather") && fuzzyWeather(q) && (!historical || explicitCurrent)) {
    matches.push({ category: "weather", re: WEATHER_RE, reason: "weather term (fuzzy/misspelled)", conf: 0.85 });
  }

  if (matches.length === 0) {
    return { isCurrentFacts: false, requiresTool: false, confidence: 0, category: null, reason: "not time-sensitive", suggestedQuery: cleanQuery(q) };
  }

  // Primary = highest-confidence NON-time-relative match if any (more specific),
  // else the time-relative one.
  const nonTime = matches.filter((m) => m.category !== "time-relative");
  const primary = (nonTime.length ? nonTime : matches).reduce((a, b) => (b.conf > a.conf ? b : a));
  const hasTimeMarker = matches.some((m) => m.category === "time-relative");
  // Co-occurring "right now" + a specific category → higher confidence.
  let confidence = primary.conf;
  if (hasTimeMarker && primary.category !== "time-relative") confidence = Math.min(0.98, confidence + 0.05);

  const suggestedQuery = primary.category === "weather" ? weatherQuery(q) : cleanQuery(q);

  return {
    isCurrentFacts: true,
    requiresTool: true,
    confidence: +confidence.toFixed(2),
    category: primary.category,
    reason: primary.reason,
    suggestedQuery,
  };
}

// ----- source routing (Web Capability, 2026-06-02) -----
//
// Additive: maps a query to the specialized web tools that best fit it, in
// addition to general search. Used by the chat surface / Bart's prompt to bias
// tool choice. Does NOT change detectCurrentFacts.

const ROUTE_RULES: Array<{ re: RegExp; tools: string[] }> = [
  { re: /\b(arxiv|paper|papers|preprint|fine[- ]?tun(e|ing)|transformer|llm|neural|machine learning|deep learning|diffusion|benchmark|sota|state[- ]of[- ]the[- ]art)\b/i, tools: ["arxiv_search", "papers_with_code", "openalex_search"] },
  { re: /\b(model|dataset|checkpoint|weights|gguf|safetensors|hugging ?face)\b/i, tools: ["huggingface_hub"] },
  { re: /\b(disease|symptom|clinical|patient|cancer|drug|gene|protein|therap(y|eutic)|medical|biolog|vaccine|trial)\b/i, tools: ["pubmed_search"] },
  { re: /\b(doi|journal|citation|cited by|peer[- ]reviewed|publication)\b/i, tools: ["crossref_lookup", "openalex_search"] },
  { re: /\b(news|breaking|headline|happening|protest|election|conflict|outbreak|event(s)? in)\b/i, tools: ["gdelt_events", "searxng_search"] },
  { re: /\b(code|coding|function|library|api|error|exception|stack ?trace|bug|repo|repository|npm|pip|git ?hub|compile|typescript|python|rust|golang)\b/i, tools: ["github_search", "stackexchange_search"] },
  { re: /\b(10[- ]?[kq]|sec filing|earnings|annual report|quarterly|insider trading|ticker|nasdaq|nyse|public company|ceo of)\b/i, tools: ["sec_edgar", "wikipedia_search"] },
  { re: /\bwho (is|was|are)\b|\bwhat (is|are)\b|\b(biography|born|founded|capital of|population of)\b/i, tools: ["wikipedia_search", "wikidata_query"] },
];

/** Recommend web tools for a query (best-first, deduped). chain_search_to_read
 *  is the default first suggestion (it searches AND reads); specialized tools
 *  follow when the query type is clear. */
export function suggestSources(query: string): string[] {
  const q = (query ?? "").trim();
  if (!q) return [];
  const out: string[] = ["chain_search_to_read"];
  for (const rule of ROUTE_RULES) {
    if (rule.re.test(q)) {
      for (const t of rule.tools) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
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
