// lib/tools/contract-extract.ts — T13 Contract Clause Extractor (safe)
//
// Extracts standard clauses from contract text (raw text, a path, or a vault
// docId) using Bartimaeus's model. Read-only analysis → no approval.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { callModel } from "./util";
import { resolveSourcePath } from "./fs-guard";
import { extractText } from "../vault/extract";
import { PERSONA_BY_ID } from "../personas";

export const ID = "contract_extract";

const CLAUSES = [
  "payment terms",
  "termination",
  "liability",
  "indemnification",
  "intellectual property",
  "non-compete",
];

function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < 0 || e < s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const execute: ToolExecute = async (params, ctx) => {
  let text = typeof params.text === "string" ? params.text : "";
  if (!text) {
    const src = await resolveSourcePath(params);
    if (!src.ok || !src.abs) return toolErr(ID, src.error ?? "no contract source");
    try {
      text = await extractText(src.abs);
    } catch (e) {
      return toolErr(ID, `extraction failed: ${(e as Error).message}`);
    }
  }
  if (!text.trim()) return toolErr(ID, "no contract text to analyze");

  const model = ctx.model || PERSONA_BY_ID.bartimaeus.model;
  const system =
    "You are a contract analyst. Extract the requested clauses precisely. Output ONLY a JSON object mapping each clause name to a concise summary of its terms, or \"not found\" if absent. No prose, no markdown.";
  const user = `Extract these clauses: ${CLAUSES.join(", ")}.\n\nCONTRACT:\n${text.slice(0, 8000)}`;

  let out: string;
  try {
    out = await callModel(model, system, user, { timeoutMs: 120_000, signal: ctx.signal });
  } catch (e) {
    return toolErr(ID, `model extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const clauses = parseJsonObject(out);
  if (!clauses) {
    return toolOk(ID, "extracted clauses (unstructured)", {
      data: { clauses: null, raw: out.slice(0, 2000) },
    });
  }
  return toolOk(ID, `extracted ${Object.keys(clauses).length} clause group(s)`, {
    data: { clauses },
  });
};
