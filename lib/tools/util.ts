// lib/tools/util.ts
//
// Tools Phase (2026-06-02) — shared helpers for tool implementations:
// timed fetch, HTML→text, output-file writes, CSV parsing, and a non-streaming
// model call (for clause/threat extraction).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { getOllamaBase } from "../ollama-config";
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
