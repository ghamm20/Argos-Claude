// lib/tools/osint.ts — T4 OSINT Lookup (safe)
//
// Person / company / domain reconnaissance from open sources. Combines web
// search + RDAP (the modern WHOIS, clean JSON, no key) + a public LinkedIn
// site-search + a news search. Every datum is clearly labelled with its
// source. Graceful: any failing source is skipped, not fatal.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { ddgSearch } from "./web-search";
import { fetchText } from "./util";

export const ID = "osint_lookup";

interface OsintSection {
  source: string;
  label: string;
  items: string[];
}

function looksLikeDomain(s: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(s.trim());
}

async function rdapDomain(domain: string): Promise<OsintSection | null> {
  const r = await fetchText(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    timeoutMs: 10_000,
    headers: { accept: "application/rdap+json" },
  });
  if (!r.ok || !r.text) return null;
  try {
    const j = JSON.parse(r.text) as {
      ldhName?: string;
      status?: string[];
      events?: Array<{ eventAction?: string; eventDate?: string }>;
      entities?: Array<{ roles?: string[]; vcardArray?: unknown }>;
    };
    const items: string[] = [];
    if (j.ldhName) items.push(`Domain: ${j.ldhName}`);
    if (j.status?.length) items.push(`Status: ${j.status.join(", ")}`);
    for (const e of j.events ?? []) {
      if (e.eventAction && e.eventDate) items.push(`${e.eventAction}: ${e.eventDate}`);
    }
    const roles = (j.entities ?? []).flatMap((e) => e.roles ?? []);
    if (roles.length) items.push(`Entity roles: ${[...new Set(roles)].join(", ")}`);
    return { source: "RDAP / WHOIS (rdap.org)", label: "Registration", items };
  } catch {
    return null;
  }
}

export const execute: ToolExecute = async (params) => {
  const subject = String(params.subject ?? params.query ?? "").trim();
  if (!subject) return toolErr(ID, "subject (person/company/domain) is required");

  const sections: OsintSection[] = [];

  // Domain registration (RDAP).
  if (looksLikeDomain(subject)) {
    try {
      const rdap = await rdapDomain(subject);
      if (rdap) sections.push(rdap);
    } catch {
      /* skip */
    }
  }

  // General web search.
  try {
    const web = await ddgSearch(subject, 5);
    if (web.length) {
      sections.push({
        source: "Web search (DuckDuckGo)",
        label: "Web presence",
        items: web.map((r) => `${r.title} — ${r.url}`),
      });
    }
  } catch {
    /* skip */
  }

  // LinkedIn public profiles (site-restricted search).
  try {
    const li = await ddgSearch(`${subject} site:linkedin.com`, 3);
    if (li.length) {
      sections.push({
        source: "LinkedIn (public, via search)",
        label: "Professional",
        items: li.map((r) => `${r.title} — ${r.url}`),
      });
    }
  } catch {
    /* skip */
  }

  // News mentions.
  try {
    const news = await ddgSearch(`${subject} news`, 3);
    if (news.length) {
      sections.push({
        source: "News search",
        label: "Recent mentions",
        items: news.map((r) => `${r.title} — ${r.url}`),
      });
    }
  } catch {
    /* skip */
  }

  if (sections.length === 0) {
    return toolOk(ID, `no OSINT data retrieved for "${subject}" (offline or blocked)`, {
      data: { subject, sections: [] },
    });
  }

  const sources = sections.flatMap((s) =>
    s.items.map((i) => i.split(" — ")[1]).filter((u): u is string => !!u && /^https?:/.test(u))
  );
  return toolOk(ID, `OSINT profile for "${subject}" from ${sections.length} source(s)`, {
    data: { subject, sections },
    sources,
  });
};
