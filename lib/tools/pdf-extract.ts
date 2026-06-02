// lib/tools/pdf-extract.ts — T7 PDF Extraction (safe)
//
// Reuses the existing vault PDF pipeline (pdf-parse via lib/vault/extract).
// Accepts a vault docId or a path within ARGOS_ROOT.

import { toolOk, toolErr, type ToolExecute } from "./types";
import { extractText } from "../vault/extract";
import { resolveSourcePath } from "./fs-guard";

export const ID = "pdf_extract";
const PREVIEW_CHARS = 4000;

export const execute: ToolExecute = async (params) => {
  const src = await resolveSourcePath(params);
  if (!src.ok || !src.abs) return toolErr(ID, src.error ?? "no PDF source");
  if (!/\.pdf$/i.test(src.abs)) {
    return toolErr(ID, "source is not a .pdf");
  }
  let text: string;
  try {
    text = await extractText(src.abs);
  } catch (e) {
    return toolErr(ID, `extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const clean = text.replace(/\s+\n/g, "\n").trim();
  // Cheap structural cue: count likely clause/section headings.
  const headings = (clean.match(/^\s*(?:\d+\.|[A-Z][A-Z \t]{4,})\s*$/gm) ?? []).slice(0, 20);
  return toolOk(ID, `extracted ${clean.length} chars`, {
    data: {
      chars: clean.length,
      preview: clean.slice(0, PREVIEW_CHARS),
      headings,
      truncated: clean.length > PREVIEW_CHARS,
    },
  });
};
