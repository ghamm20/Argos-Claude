// lib/tools/huggingface.ts — T24 huggingface_hub (web, safe, keyless)
//
// Hugging Face Hub model/dataset discovery. Returns models with downloads,
// likes, tags, pipeline, license. 6h cache (the hub moves faster than papers).

import { toolOk, toolErr, type ToolExecute } from "./types";
import { webFetchJson } from "../web";

export const ID = "huggingface_hub";
const TTL = 6 * 60 * 60 * 1000;

interface HfModel {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: string[];
  library_name?: string;
}
interface HfDataset {
  id?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
}

function licenseFrom(tags: string[] = []): string | null {
  const t = tags.find((x) => x.startsWith("license:"));
  return t ? t.slice("license:".length) : null;
}

export const execute: ToolExecute = async (params) => {
  const q = String(params.query ?? "").trim();
  if (!q) return toolErr(ID, "query is required");
  const kind = params.kind === "datasets" ? "datasets" : "models";
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 25) : 10;
  const url = `https://huggingface.co/api/${kind}?search=${encodeURIComponent(q)}&limit=${limit}&sort=downloads&direction=-1`;

  const r = await webFetchJson<Array<HfModel | HfDataset>>({ source: "huggingface", op: kind, url, query: q, ttlMs: TTL });
  if (!r.ok) return toolErr(ID, r.error ?? "Hugging Face request failed");
  const rows = (r.data ?? []).slice(0, limit).map((m) => {
    const id = (m as HfModel).id ?? (m as HfModel).modelId ?? "";
    return {
      id,
      url: id ? `https://huggingface.co/${kind === "datasets" ? "datasets/" : ""}${id}` : null,
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      pipeline: (m as HfModel).pipeline_tag ?? null,
      library: (m as HfModel).library_name ?? null,
      license: licenseFrom(m.tags),
      tags: (m.tags ?? []).filter((t) => !t.includes(":")).slice(0, 8),
    };
  });
  if (rows.length === 0) return toolErr(ID, `no Hugging Face ${kind} matched`);
  return toolOk(ID, `Hugging Face: ${rows.length} ${kind} for "${q}"`, {
    data: { query: q, kind, results: rows, fromCache: r.fromCache },
    sources: rows.map((m) => m.url).filter((u): u is string => !!u).slice(0, 10),
  });
};
