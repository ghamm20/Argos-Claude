// lib/research/planner.ts
//
// Phase 10 — research intent + query planner. Deterministic keyword
// matching, no LLM call. Cheap to run on every chat turn so the
// chat route can skip the rest of the pipeline when needsResearch
// returns false.

import type {
  ResearchIntent,
  ResearchLocation,
  SearchQuery,
} from "./types";

// ----- intent keyword tables -----
//
// Order matters: classifyIntent walks these tables and returns the
// FIRST match. Weather is checked before news because "weather" can
// appear in news contexts ("news about the weather") but we want it
// in the weather stream. Same logic for AI updates beating news.

const WEATHER_KEYWORDS = [
  "weather",
  "forecast",
  "temperature",
  "temp ",
  "rain",
  "rainy",
  "storm",
  "humidity",
  "snow",
  "wind",
  "hurricane",
  "tornado",
  "heat wave",
  "cold front",
];

const AI_KEYWORDS = [
  "ai update",
  "ai news",
  "artificial intelligence",
  "llm",
  "gpt-",
  "gpt5",
  "gpt-5",
  "openai",
  "anthropic",
  "claude",
  "gemini",
  "mistral",
  "groq",
  "perplexity",
  "huggingface",
  "hugging face",
  "new model",
  "model release",
  "model card",
  "ai research",
  "ml paper",
  "arxiv",
  "deepseek",
  "qwen",
  "llama",
];

const NEWS_KEYWORDS = [
  "news",
  "what's happening",
  "whats happening",
  "what is happening",
  "latest",
  "headline",
  "headlines",
  "update",
  "updates",
  "today in",
  "recent",
  "breaking",
];

const CRAWL_KEYWORDS = [
  "look up",
  "look this up",
  "research",
  "find out",
  "search for",
  "what is",
  "what's the",
  "whats the",
  "who is",
  "who's",
  "whos",
  "explain",
  "tell me about",
  "deep dive",
];

// ----- location detection -----

const LOCATION_PATTERNS: Array<{ loc: ResearchLocation; tokens: string[] }> = [
  // Order matters: more-specific before less-specific.
  { loc: "winter_springs", tokens: ["winter springs", "winter spring"] },
  {
    loc: "orlando",
    tokens: [
      "orlando",
      "central florida",
      "fla.",
      // Bare "florida" / "fl" are weak signals; we still accept them
      // because the operator's two markets are GA + FL.
      "florida",
      " fl ",
      " fl.",
    ],
  },
  {
    loc: "atlanta",
    tokens: ["atlanta", " atl ", " atl.", "georgia", " ga ", " ga."],
  },
];

/**
 * Detect a location from the message. Pads the message with spaces
 * on both ends so " atl " etc. matches at edges. Returns the FIRST
 * matching location (location patterns are ordered by specificity).
 * Returns null when no match.
 */
export function detectLocation(message: string): ResearchLocation {
  const padded = ` ${message.toLowerCase()} `;
  for (const { loc, tokens } of LOCATION_PATTERNS) {
    if (tokens.some((t) => padded.includes(t))) return loc;
  }
  return null;
}

// ----- intent classification -----

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Classify the dominant research intent from a user message. Returns
 * "general" as a fallback when no specific intent triggers but the
 * message still looks like a research request (caught by
 * needsResearch). Walks specific → general so weather/AI beat news,
 * news beats crawl, crawl beats general.
 */
export function classifyIntent(message: string): ResearchIntent {
  const lower = message.toLowerCase();
  if (containsAny(lower, WEATHER_KEYWORDS)) return "weather";
  if (containsAny(lower, AI_KEYWORDS)) return "ai_updates";
  if (containsAny(lower, NEWS_KEYWORDS)) return "news";
  if (containsAny(lower, CRAWL_KEYWORDS)) return "crawl";
  return "general";
}

/**
 * True when the message contains anything that would warrant a
 * network round-trip. The chat route uses this as the network-mode
 * gate: false → no network, no research, no cache touch.
 *
 * Conservative by design — we'd rather miss a research opportunity
 * than fire network on every "hello".
 */
export function needsResearch(message: string): boolean {
  if (!message || message.trim().length === 0) return false;
  const lower = message.toLowerCase();
  return (
    containsAny(lower, WEATHER_KEYWORDS) ||
    containsAny(lower, AI_KEYWORDS) ||
    containsAny(lower, NEWS_KEYWORDS) ||
    containsAny(lower, CRAWL_KEYWORDS)
  );
}

// ----- query generation -----

/** Atlanta + Orlando are the operator's two home markets. Used when
 *  no specific location was detected in a location-relevant intent. */
const HOME_MARKETS: ResearchLocation[] = ["atlanta", "orlando"];

function locationDisplay(loc: ResearchLocation): string {
  if (loc === "atlanta") return "Atlanta GA";
  if (loc === "orlando") return "Orlando FL";
  if (loc === "winter_springs") return "Winter Springs FL";
  return "";
}

/**
 * Generate 1..N targeted search queries from the user's message and
 * the classified intent. Each query carries its intent + location
 * tag so the searcher can dispatch to the right provider.
 *
 * Per-intent generation rules:
 *   - weather: 1 query per relevant location (1-2 total)
 *   - news: 2-3 queries (local + regional + national)
 *   - ai_updates: 3 queries (latest models, papers, industry)
 *   - crawl: 2-4 queries from the user's topic
 *   - general: 1 verbatim query
 */
export function planQueries(
  message: string,
  intent: ResearchIntent
): SearchQuery[] {
  const loc = detectLocation(message);

  switch (intent) {
    case "weather": {
      const locs = loc ? [loc] : HOME_MARKETS;
      return locs.map((l) => ({
        query: `weather ${locationDisplay(l)}`,
        intent,
        location: l,
        maxResults: 1,
      }));
    }

    case "news": {
      const out: SearchQuery[] = [];
      const locs = loc ? [loc] : HOME_MARKETS;
      for (const l of locs) {
        out.push({
          query: `${locationDisplay(l)} local news`,
          intent,
          location: l,
          maxResults: 5,
        });
      }
      // Always include a national headlines query as the third
      // (alongside up to 2 local queries).
      out.push({
        query: "top headlines today",
        intent,
        location: null,
        maxResults: 5,
      });
      return out;
    }

    case "ai_updates": {
      return [
        {
          query: "new AI model release this week",
          intent,
          location: null,
          maxResults: 5,
        },
        {
          query: "AI research paper announcement",
          intent,
          location: null,
          maxResults: 5,
        },
        {
          query: "OpenAI Anthropic Google AI industry news",
          intent,
          location: null,
          maxResults: 5,
        },
      ];
    }

    case "crawl": {
      // Strip the trigger phrase off the front so the actual topic
      // is what we search. "look up X" → "X".
      const stripped = stripCrawlTriggers(message);
      const out: SearchQuery[] = [
        {
          query: stripped,
          intent,
          location: null,
          maxResults: 5,
        },
      ];
      // For non-trivial topics, add a sibling query that asks
      // "what is" or "overview of" — covers both Q&A and reference.
      if (stripped.length > 12 && !stripped.toLowerCase().startsWith("what")) {
        out.push({
          query: `what is ${stripped}`,
          intent,
          location: null,
          maxResults: 5,
        });
      }
      return out;
    }

    case "general":
    default: {
      return [
        {
          query: message.trim(),
          intent,
          location: loc,
          maxResults: 5,
        },
      ];
    }
  }
}

function stripCrawlTriggers(message: string): string {
  let t = message.trim();
  for (const k of CRAWL_KEYWORDS) {
    const re = new RegExp(`^\\s*${k}\\s+`, "i");
    if (re.test(t)) {
      t = t.replace(re, "").trim();
      break;
    }
  }
  // Trim trailing question marks for cleaner search URLs.
  return t.replace(/[?!.]+$/, "").trim();
}
