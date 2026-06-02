// lib/tools/rsshub.ts — T33 rsshub_feed (web, safe, keyless)
//
// Self-hosted RSSHub (127.0.0.1:1200) — generates RSS for sites without native
// feeds. The operator passes a route path (e.g. "github/trending/daily/any").
// Parses RSS 2.0 + Atom. 30min cache.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetch } from "../web";
import { decodeEntities } from "./util";

export const ID = "rsshub_feed";
const TTL = 30 * 60 * 1000;
const BASE = "http://127.0.0.1:1200"; // local RSSHub (Rule-4 allows 127.0.0.1)

interface FeedItem {
  title: string;
  link: string;
  date: string | null;
  description: string;
}

const grab = (block: string, name: string): string => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return "";
  let v = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeEntities(v.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
};

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    let link = grab(block, "link");
    if (isAtom || !link) {
      const lm = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (lm) link = lm[1];
    }
    items.push({
      title: grab(block, "title"),
      link,
      date: grab(block, "pubDate") || grab(block, "updated") || grab(block, "published") || null,
      description: (grab(block, "description") || grab(block, "summary") || grab(block, "content")).slice(0, 400),
    });
    if (items.length >= 30) break;
  }
  return items;
}

export const execute: ToolExecute = async (params) => {
  let path = String(params.path ?? "").trim().replace(/^\/+/, "");
  if (!path) return toolErr(ID, "path is required (e.g. 'github/trending/daily/any')");
  const url = `${BASE}/${path}`;
  const r = await webFetch({ source: "rsshub", op: "feed", url, query: path, ttlMs: TTL, timeoutMs: 20_000, retries: 1, maxChars: 200_000 });
  if (!r.ok) return toolErr(ID, r.error ?? `RSSHub route failed (is the container up on :1200?)`);
  const items = parseFeed(r.body);
  if (items.length === 0) return toolErr(ID, "RSSHub returned no feed items (check the route path)");
  return toolOk(ID, `RSSHub: ${items.length} item(s) from /${path}`, {
    data: { path, items, fromCache: r.fromCache },
    sources: items.map((i) => i.link).filter(Boolean).slice(0, 10),
  });
};
