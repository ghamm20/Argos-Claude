// lib/research/factchecker.ts
//
// Cross-reference claims across crawled pages. Deterministic, no
// LLM call. Three buckets:
//
//   verifiedFacts — appear in 2+ independent sources (host-deduped)
//   conflicts     — same topic key has different numeric values
//   unverified    — appear in only 1 source (most facts; not a
//                   negative signal, just unconfirmed)
//
// "Same topic" detection is necessarily crude — we extract the
// numeric span + the surrounding 4-6 words and use that as a
// signature. Good enough to catch e.g. "Atlanta 78°F" vs "Atlanta
// 82°F" but won't catch deeper contradictions. The reporter passes
// the bucket counts into the confidence calculation.

import type { CrawledPage } from "./types";

export interface FactCheckResult {
  verifiedFacts: string[];
  conflicts: string[];
  unverified: string[];
}

/** Normalise a sentence for cross-reference comparison. Lowercases,
 *  strips punctuation/whitespace, collapses whitespace. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the (number + surrounding context) signature from a
 *  sentence. Picks the first numeric span and the ~4 tokens
 *  surrounding it. Returns null when no number present. */
function numericSignature(sentence: string): {
  topic: string;
  value: number;
  unit: string;
} | null {
  const norm = normalize(sentence);
  // Match a number optionally with decimal/percent/degree marker.
  const m = norm.match(
    /(?:^|\s)(\w{3,}\s+\w{3,}\s+)?(\d{1,5}(?:\.\d+)?)\s*(°f|°c|°|percent|%|mph|kph|mm|inches|in|kg|lbs|usd|million|billion|thousand)?(?:\s+(\w{3,}\s+\w{3,}))?/
  );
  if (!m) return null;
  const before = (m[1] ?? "").trim();
  const value = parseFloat(m[2]);
  const unit = (m[3] ?? "").trim();
  const after = (m[4] ?? "").trim();
  if (!Number.isFinite(value)) return null;
  // Topic key is the bigram-context around the number, normalised.
  const topic = [before, after].filter((s) => s.length > 0).join(" ");
  if (!topic) return null;
  return { topic, value, unit };
}

/** Extract the host from a URL for source independence. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Run the fact-check pass. Per-page facts are walked once, grouped
 * by normalised sentence text (for verification) AND by numeric
 * signature (for conflict detection).
 */
export function checkFacts(pages: CrawledPage[]): FactCheckResult {
  if (!pages || pages.length === 0) {
    return { verifiedFacts: [], conflicts: [], unverified: [] };
  }

  // For verification: map normalised-sentence → distinct host set
  const sentenceHosts = new Map<
    string,
    { original: string; hosts: Set<string> }
  >();
  // For conflict detection: map topic key → { value, unit, host }[]
  const topicValues = new Map<
    string,
    { value: number; unit: string; host: string; sentence: string }[]
  >();

  for (const page of pages) {
    const pageHost = host(page.url);
    for (const f of page.facts) {
      const norm = normalize(f);
      if (norm.length < 12) continue;
      const slot = sentenceHosts.get(norm);
      if (slot) {
        slot.hosts.add(pageHost);
      } else {
        sentenceHosts.set(norm, {
          original: f,
          hosts: new Set([pageHost]),
        });
      }
      const sig = numericSignature(f);
      if (sig) {
        const bucket = topicValues.get(sig.topic) ?? [];
        bucket.push({
          value: sig.value,
          unit: sig.unit,
          host: pageHost,
          sentence: f,
        });
        topicValues.set(sig.topic, bucket);
      }
    }
  }

  // Bucket: verified vs unverified.
  const verified: string[] = [];
  const unverified: string[] = [];
  for (const { original, hosts } of sentenceHosts.values()) {
    if (hosts.size >= 2) verified.push(original);
    else unverified.push(original);
  }

  // Bucket: conflicts. A topic has a conflict when 2+ distinct hosts
  // report DIFFERENT values for the same topic + unit.
  const conflicts: string[] = [];
  for (const [topic, bucket] of topicValues.entries()) {
    if (bucket.length < 2) continue;
    // Group by unit; ignore single-host conflicts (same publisher
    // updating their own numbers is not a contradiction).
    const byUnit = new Map<
      string,
      { value: number; host: string; sentence: string }[]
    >();
    for (const e of bucket) {
      const u = e.unit || "_";
      const arr = byUnit.get(u) ?? [];
      arr.push({ value: e.value, host: e.host, sentence: e.sentence });
      byUnit.set(u, arr);
    }
    for (const [, arr] of byUnit.entries()) {
      const hosts = new Set(arr.map((a) => a.host));
      if (hosts.size < 2) continue;
      const values = new Set(arr.map((a) => a.value));
      if (values.size < 2) continue;
      // Build a single conflict line: "topic: X (host1) vs Y (host2)"
      const samples = arr
        .slice(0, 3)
        .map((a) => `${a.value}${a.host ? ` (${a.host})` : ""}`)
        .join(" vs ");
      conflicts.push(`${topic}: ${samples}`);
    }
  }

  return { verifiedFacts: verified, conflicts, unverified };
}
