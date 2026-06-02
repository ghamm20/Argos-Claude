// lib/tools/jina-reader.ts — T32 jina_reader (web, safe, keyless)
//
// Jina Reader (https://r.jina.ai/<url>) returns clean Markdown for any URL —
// the primary content-extraction path (web_crawl stays as fallback). 12h cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetch } from "../web";

export const ID = "jina_reader";
const TTL = 12 * 60 * 60 * 1000;

export const execute: ToolExecute = async (params) => {
  const target = String(params.url ?? "").trim();
  if (!target) return toolErr(ID, "url is required");
  if (!/^https?:\/\//i.test(target)) return toolErr(ID, "url must start with http(s)://");

  const readerUrl = `https://r.jina.ai/${target}`;
  const r = await webFetch({
    source: "jina_reader",
    op: "read",
    url: readerUrl,
    query: target,
    ttlMs: TTL,
    timeoutMs: 30_000,
    retries: 2,
    maxChars: 60_000,
    headers: { "x-return-format": "markdown", accept: "text/plain, text/markdown, */*" },
  });
  if (!r.ok || !r.body.trim()) return toolErr(ID, r.error ?? "Jina Reader returned no content");

  const md = r.body.trim();
  // Jina prefixes "Title:" / "URL Source:" lines — pull the title if present.
  const titleM = md.match(/^Title:\s*(.+)$/m);
  return toolOk(ID, `Read ${target} (${md.length} chars)`, {
    data: { url: target, title: titleM ? titleM[1].trim() : null, markdown: md, length: md.length, fromCache: r.fromCache },
    sources: [target],
  });
};
