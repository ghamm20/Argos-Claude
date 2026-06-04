// lib/tools/openlibrary.ts — T45 openlibrary (web, safe, keyless)
//
// Open Library search — books, authors, editions, subjects.
// https://openlibrary.org/search.json (keyless).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "openlibrary";
const TTL = 24 * 60 * 60 * 1000; // 24h

interface OlDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
  isbn?: string[];
  subject?: string[];
}
interface OlResp { numFound?: number; docs?: OlDoc[] }

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? params.title ?? "").trim();
  const author = String(params.author ?? "").trim();
  if (!q && !author) return toolErr(ID, "provide `query` (title/keywords) or `author`");
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 20) : 10;
  const parts: string[] = [];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (author) parts.push(`author=${encodeURIComponent(author)}`);
  parts.push(`limit=${limit}`, "fields=key,title,author_name,first_publish_year,edition_count,isbn,subject");
  const url = `https://openlibrary.org/search.json?${parts.join("&")}`;

  const r = await webFetchJson<OlResp>({ source: "openlibrary", op: "search", url, query: q || author, ttlMs: TTL, timeoutMs: 20000 });
  if (!r.ok) return toolErr(ID, `Open Library request failed (HTTP ${r.status})${r.error ? `: ${r.error}` : ""}`);
  const books = (r.data?.docs ?? []).map((d) => ({
    title: d.title ?? "(untitled)",
    authors: d.author_name ?? [],
    firstPublished: d.first_publish_year ?? null,
    editions: d.edition_count ?? null,
    isbn: (d.isbn ?? []).slice(0, 1)[0] ?? null,
    subjects: (d.subject ?? []).slice(0, 5),
    url: d.key ? `https://openlibrary.org${d.key}` : null,
  }));
  if (books.length === 0) return toolErr(ID, `Open Library found 0 books for "${q || author}"`);
  return toolOk(ID, `Open Library: ${books.length} book(s) for "${q || author}" (of ${r.data?.numFound ?? books.length})`, {
    data: { query: q || author, total: r.data?.numFound ?? books.length, books, fromCache: r.fromCache },
    sources: books.map((b) => b.url).filter((u): u is string => !!u),
  });
};
