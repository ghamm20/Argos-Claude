// lib/tools/csv-analysis.ts — T6 Spreadsheet / CSV Analysis (safe)
//
// Reads a CSV (vault docId or path within ARGOS_ROOT), parses with the built-in
// parser (no deps), and reports shape, a per-column summary, and anomalies.
// Hard 10 MB cap.

import { promises as fsp } from "node:fs";
import { toolOk, toolErr, type ToolExecute } from "./types";
import { parseCsv } from "./util";
import { resolveSourcePath } from "./fs-guard";

export const ID = "csv_analysis";
const MAX_BYTES = 10 * 1024 * 1024;

export const execute: ToolExecute = async (params) => {
  // Allow inline CSV text too, for ad-hoc analysis.
  let text = typeof params.text === "string" ? params.text : "";
  if (!text) {
    const src = await resolveSourcePath(params);
    if (!src.ok || !src.abs) return toolErr(ID, src.error ?? "no CSV source");
    try {
      const st = await fsp.stat(src.abs);
      if (st.size > MAX_BYTES) {
        return toolErr(ID, `file exceeds 10 MB (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
      }
      text = await fsp.readFile(src.abs, "utf8");
    } catch (e) {
      return toolErr(ID, `read failed: ${(e as Error).message}`);
    }
  }
  if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);

  const { columns, rows } = parseCsv(text);
  if (columns.length === 0) return toolErr(ID, "no columns parsed (is this a CSV?)");

  const anomalies: string[] = [];
  // Row-width anomalies.
  let raggedRows = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== columns.length) raggedRows++;
  }
  if (raggedRows > 0) {
    anomalies.push(`${raggedRows} row(s) have a different column count than the header`);
  }
  // Per-column summary.
  const summary = columns.map((col, ci) => {
    let empties = 0;
    let numeric = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      const v = (r[ci] ?? "").trim();
      if (!v) {
        empties++;
        continue;
      }
      const n = Number(v.replace(/[$,%\s]/g, ""));
      if (Number.isFinite(n)) {
        numeric++;
        min = Math.min(min, n);
        max = Math.max(max, n);
      }
    }
    const isNumeric = numeric > 0 && numeric >= rows.length * 0.6;
    if (rows.length > 0 && empties > rows.length * 0.5) {
      anomalies.push(`column "${col}" is >50% empty`);
    }
    return {
      column: col,
      empties,
      numeric: isNumeric,
      ...(isNumeric ? { min, max } : {}),
    };
  });

  return toolOk(ID, `${rows.length} rows × ${columns.length} columns, ${anomalies.length} anomaly(ies)`, {
    data: { rows: rows.length, columns, summary, anomalies },
  });
};
