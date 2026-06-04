// lib/tools/nvd-cve.ts — T37 nvd_cve (web, safe, keyless)
//
// NVD CVE 2.0 API — vulnerability lookup by keyword or CVE id.
// https://services.nvd.nist.gov/rest/json/cves/2.0 (keyless; ~5 req/30s).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "nvd_cve";
const TTL = 6 * 60 * 60 * 1000; // 6h
const BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";

interface NvdCve {
  id?: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang?: string; value?: string }>;
  metrics?: {
    cvssMetricV31?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>;
    cvssMetricV30?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>;
  };
}
interface NvdResp { totalResults?: number; vulnerabilities?: Array<{ cve?: NvdCve }> }

export const execute: ToolExecute = async (params) => {
  const cveId = String(params.cveId ?? params.id ?? "").trim();
  const q = String(params.query ?? params.keyword ?? "").trim();
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 20) : 8;
  let url: string;
  if (/^cve-\d{4}-\d+$/i.test(cveId)) {
    url = `${BASE}?cveId=${encodeURIComponent(cveId.toUpperCase())}`;
  } else if (q) {
    url = `${BASE}?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=${limit}`;
  } else {
    return toolErr(ID, "provide a `query` (keyword) or a `cveId` (e.g. CVE-2024-3094)");
  }

  const r = await webFetchJson<NvdResp>({ source: "nvd", op: "cve", url, query: q || cveId, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) return toolErr(ID, `NVD request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const items = (r.data?.vulnerabilities ?? []).map((v) => {
    const c = v.cve ?? {};
    const m = c.metrics?.cvssMetricV31?.[0]?.cvssData ?? c.metrics?.cvssMetricV30?.[0]?.cvssData;
    return {
      id: c.id ?? null,
      published: c.published ?? null,
      status: c.vulnStatus ?? null,
      severity: m?.baseSeverity ?? null,
      score: m?.baseScore ?? null,
      description: (c.descriptions ?? []).find((d) => d.lang === "en")?.value?.slice(0, 400) ?? null,
      url: c.id ? `https://nvd.nist.gov/vuln/detail/${c.id}` : null,
    };
  });
  if (items.length === 0) return toolErr(ID, `no CVEs matched "${q || cveId}" (NVD returned 0 results)`);
  return toolOk(ID, `NVD: ${items.length} CVE(s) for "${q || cveId}" (of ${r.data?.totalResults ?? items.length})`, {
    data: { query: q || cveId, total: r.data?.totalResults ?? items.length, cves: items, fromCache: r.fromCache },
    sources: items.map((i) => i.url).filter((u): u is string => !!u),
  });
};
