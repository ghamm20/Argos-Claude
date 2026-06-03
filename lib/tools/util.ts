// lib/tools/util.ts
//
// Tools Phase (2026-06-02) — shared helpers for tool implementations:
// timed fetch, HTML→text, output-file writes, CSV parsing, and a non-streaming
// model call (for clause/threat extraction).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { getOllamaBase, KEEP_ALIVE_BACKGROUND } from "../ollama-config";
import { outputDir } from "./paths";

export const TOOL_UA =
  "Mozilla/5.0 (compatible; ARGOS-Tools/1.0; +local)";

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
  contentType?: string;
}

export async function fetchText(
  url: string,
  opts: {
    timeoutMs?: number;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxChars?: number;
  } = {}
): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "user-agent": TOOL_UA, ...(opts.headers ?? {}) },
      body: opts.body,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const ct = res.headers.get("content-type") ?? "";
    let text = await res.text();
    if (opts.maxChars && text.length > opts.maxChars) text = text.slice(0, opts.maxChars);
    return { ok: res.ok, status: res.status, text, contentType: ct };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&#x27;": "'", "&nbsp;": " ", "&apos;": "'",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;|&#x?\w+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** Strip HTML to readable text: drop script/style, tags → spaces, decode
 *  entities, collapse whitespace. */
export function stripHtml(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const text = noScript.replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
}

export function extractMetaDescription(html: string): string | null {
  const m =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return m ? decodeEntities(m[1]).trim() : null;
}

// Unrestricted web crawl (2026-06-02) — full structured extraction.

/** Rotating user-agents for multi-attempt fetches (some sites gate on UA). */
export const CRAWL_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

/** Fetch a URL trying multiple user-agents until one returns usable HTML.
 *  We can't execute JavaScript without a browser engine (no new deps), so this
 *  is the honest "render as best we can" path: follow redirects, retry under
 *  different UAs, and prefer the response with the most extractable text. */
export async function fetchWithUserAgents(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number } = {}
): Promise<FetchResult & { uaUsed?: string }> {
  let best: (FetchResult & { uaUsed?: string }) | null = null;
  for (const ua of CRAWL_USER_AGENTS) {
    const r = await fetchText(url, {
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxChars: opts.maxChars,
      headers: {
        "user-agent": ua,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (r.ok && r.text) {
      const score = stripHtml(r.text).length;
      if (!best || score > stripHtml(best.text).length) best = { ...r, uaUsed: ua };
      // A solidly-rendered page (lots of text) is good enough; stop early.
      if (score > 1500) break;
    } else if (!best) {
      best = { ...r, uaUsed: ua };
    }
  }
  return best ?? { ok: false, status: 0, text: "" };
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Extract absolute http(s) hyperlinks from a page (deduped, capped). */
export function extractLinks(html: string, baseUrl: string, max = 200): string[] {
  const out = new Set<string>();
  const re = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const abs = absolutize(m[1].trim(), baseUrl);
    if (abs && /^https?:\/\//i.test(abs)) out.add(abs);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Extract absolute image URLs from a page (deduped, capped). */
export function extractImages(html: string, baseUrl: string, max = 100): string[] {
  const out = new Set<string>();
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const abs = absolutize(m[1].trim(), baseUrl);
    if (abs && /^https?:\/\//i.test(abs)) out.add(abs);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Extract page metadata (description, OpenGraph, keywords, author, canonical). */
export function extractMetadata(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const re =
    /<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const key = m[1].toLowerCase();
    if (/description|title|keywords|author|og:|twitter:/.test(key)) {
      meta[key] = decodeEntities(m[2]).trim();
    }
  }
  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (canon) meta.canonical = canon[1];
  return meta;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "untitled"
  );
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Write content to ARGOS_ROOT/output/<timestamp>-<name>.<ext>. Returns the
 *  absolute path. */
export async function writeOutputFile(
  name: string,
  ext: string,
  content: string
): Promise<string> {
  const dir = outputDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${timestamp()}-${slugify(name)}.${ext}`);
  await fsp.writeFile(file, content, "utf8");
  return file;
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields + embedded commas
 *  and newlines). No new deps. */
export function parseCsv(text: string): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      /* skip */
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim().length > 0));
  const columns = nonEmpty.length > 0 ? nonEmpty[0] : [];
  return { columns, rows: nonEmpty.slice(1) };
}

/** Non-streaming model call for clause/threat extraction. Throws on failure. */
export async function callModel(
  model: string,
  system: string,
  user: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(`${getOllamaBase()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        // Background tool analysis (factcheck/report) — release VRAM fast
        // (keep-alive coordination).
        keep_alive: KEEP_ALIVE_BACKGROUND,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`model ${model} returned ${res.status}`);
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}
