// lib/tools/sec-edgar.ts — T31 sec_edgar (web, safe, keyless)
//
// SEC EDGAR public filings. Two modes:
//   - params.cik   → company submissions (recent filings) via data.sec.gov
//   - params.query → full-text filing search via efts.sec.gov
// SEC requires a descriptive User-Agent on every request. 24h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "sec_edgar";
const TTL = 24 * 60 * 60 * 1000;
// SEC's fair-access policy: identify the requester. Per directive.
const SEC_UA = "ARGOS Operator (gordy@ekgsecurity)";

interface FtsResp {
  hits?: {
    total?: { value?: number };
    hits?: Array<{ _id?: string; _source?: { display_names?: string[]; file_date?: string; form?: string; file_type?: string } }>;
  };
}
interface SubmissionsResp {
  name?: string;
  cik?: string;
  sicDescription?: string;
  tickers?: string[];
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

export const execute: ToolExecute = async (params) => {
  const cik = String(params.cik ?? "").replace(/\D/g, "");
  const q = String(params.query ?? "").trim();

  // --- Company submissions mode ---
  if (cik) {
    const padded = cik.padStart(10, "0");
    const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
    const r = await webFetchJson<SubmissionsResp>({ source: "sec_edgar", op: "submissions", url, query: `CIK${padded}`, ttlMs: TTL, userAgent: SEC_UA });
    if (!r.ok || !r.data) return toolErr(ID, r.error ?? "SEC submissions not found");
    const rec = r.data.filings?.recent;
    const forms = rec?.form ?? [];
    const filings = forms.slice(0, 20).map((form, i) => ({
      form,
      date: rec?.filingDate?.[i] ?? null,
      accession: rec?.accessionNumber?.[i] ?? null,
      description: rec?.primaryDocDescription?.[i] ?? null,
      url: rec?.accessionNumber?.[i] && rec?.primaryDocument?.[i]
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rec.accessionNumber[i].replace(/-/g, "")}/${rec.primaryDocument[i]}`
        : null,
    }));
    return toolOk(ID, `SEC EDGAR: ${r.data.name ?? `CIK ${padded}`} — ${filings.length} recent filing(s)`, {
      data: { cik: padded, name: r.data.name ?? null, tickers: r.data.tickers ?? [], sic: r.data.sicDescription ?? null, filings, fromCache: r.fromCache },
      sources: filings.map((f) => f.url).filter((u): u is string => !!u).slice(0, 10),
    });
  }

  // --- Full-text search mode ---
  if (!q) return toolErr(ID, "query or cik is required");
  const forms = typeof params.forms === "string" && params.forms.trim() ? `&forms=${encodeURIComponent(params.forms.trim())}` : "";
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}${forms}`;
  const r = await webFetchJson<FtsResp>({ source: "sec_edgar", op: "fts", url, query: q, ttlMs: TTL, userAgent: SEC_UA });
  if (!r.ok) return toolErr(ID, r.error ?? "SEC full-text search failed");
  const hits = (r.data?.hits?.hits ?? []).slice(0, 15).map((h) => {
    const accDoc = (h._id ?? "").split(":");
    const acc = accDoc[0] ?? "";
    return {
      company: (h._source?.display_names ?? []).join("; "),
      form: h._source?.form ?? null,
      date: h._source?.file_date ?? null,
      accession: acc || null,
      url: acc ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${encodeURIComponent(acc)}` : "https://efts.sec.gov/LATEST/search-index",
    };
  });
  if (hits.length === 0) return toolErr(ID, "no SEC filings matched");
  return toolOk(ID, `SEC EDGAR: ${hits.length} filing(s) for "${q}"`, {
    data: { query: q, total: r.data?.hits?.total?.value ?? hits.length, filings: hits, fromCache: r.fromCache },
    sources: hits.map((h) => h.url).slice(0, 10),
  });
};
