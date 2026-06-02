// lib/tools/arxiv.ts — T21 arxiv_search (web, safe, keyless)
//
// arXiv Atom API. Search by query, optional category (e.g. cs.AI) and date
// sort. Parses the Atom XML with regex (no XML dep, same approach as the
// existing search parser). Returns papers: title, authors, abstract, pdfUrl,
// published, updated, categories. 24h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetch } from "../web";

export const ID = "arxiv_search";
const TTL = 24 * 60 * 60 * 1000;

export interface ArxivPaper {
  title: string;
  authors: string[];
  abstract: string;
  pdfUrl: string;
  absUrl: string;
  published: string;
  updated: string;
  categories: string[];
}

const tag = (block: string, name: string): string => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
};

export function parseArxiv(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const authors: string[] = [];
    const aRe = /<author>\s*<name>([\s\S]*?)<\/name>/gi;
    let a: RegExpExecArray | null;
    while ((a = aRe.exec(block)) !== null) authors.push(a[1].replace(/\s+/g, " ").trim());
    const cats: string[] = [];
    const cRe = /<category[^>]*term=["']([^"']+)["']/gi;
    let c: RegExpExecArray | null;
    while ((c = cRe.exec(block)) !== null) cats.push(c[1]);
    const absUrl = tag(block, "id");
    let pdfUrl = "";
    const pdfM = block.match(/<link[^>]*title=["']pdf["'][^>]*href=["']([^"']+)["']/i);
    if (pdfM) pdfUrl = pdfM[1];
    else if (absUrl) pdfUrl = absUrl.replace("/abs/", "/pdf/");
    papers.push({
      title: tag(block, "title"),
      authors,
      abstract: tag(block, "summary"),
      pdfUrl,
      absUrl,
      published: tag(block, "published"),
      updated: tag(block, "updated"),
      categories: cats,
    });
  }
  return papers;
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const category = typeof params.category === "string" ? params.category.trim() : "";
  const maxResults = typeof params.maxResults === "number" ? Math.min(Math.max(1, params.maxResults), 25) : 10;
  const sortByDate = params.sortByDate !== false; // default: newest first

  const terms = category ? `cat:${category} AND all:${q}` : `all:${q}`;
  const sort = sortByDate ? "&sortBy=submittedDate&sortOrder=descending" : "";
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(terms)}&start=0&max_results=${maxResults}${sort}`;

  const r = await webFetch({ source: "arxiv", op: "search", url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "arXiv request failed");
  const papers = parseArxiv(r.body);
  if (papers.length === 0) return toolErr(ID, "no arXiv papers matched");
  return toolOk(ID, `arXiv: ${papers.length} paper(s) for "${q}"${category ? ` in ${category}` : ""}`, {
    data: { query: q, category: category || null, papers, fromCache: r.fromCache },
    sources: papers.map((p) => p.absUrl).filter(Boolean).slice(0, 10),
  });
};
