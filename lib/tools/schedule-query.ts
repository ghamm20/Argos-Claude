// lib/tools/schedule-query.ts — T11 Guard Schedule Query (approval, reversible)
//
// Reads any CSV/JSON dropped into ARGOS_ROOT/data/schedule/ and summarizes
// coverage, gaps, and call-offs. Live-system query → requires approval.
// Graceful: with no data source it returns a clear "connect a schedule" note
// rather than an error.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { toolOk, type ToolExecute } from "./types";
import { scheduleDataDir } from "./paths";
import { parseCsv } from "./util";

export const ID = "schedule_query";

const NO_DATA =
  "No scheduling data connected. Drop a schedule CSV into ARGOS_ROOT/data/schedule/ to enable.";

export const execute: ToolExecute = async () => {
  const dir = scheduleDataDir();
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => /\.(csv|json)$/i.test(f));
  } catch {
    return toolOk(ID, NO_DATA, { data: { connected: false, note: NO_DATA } });
  }
  if (files.length === 0) {
    return toolOk(ID, NO_DATA, { data: { connected: false, note: NO_DATA } });
  }

  const shifts: Array<Record<string, string>> = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const raw = await fsp.readFile(full, "utf8");
      if (/\.json$/i.test(f)) {
        const j = JSON.parse(raw);
        const arr = Array.isArray(j) ? j : Array.isArray(j.shifts) ? j.shifts : [];
        for (const row of arr) shifts.push(row as Record<string, string>);
      } else {
        const { columns, rows } = parseCsv(raw);
        for (const r of rows) {
          const obj: Record<string, string> = {};
          columns.forEach((c, i) => (obj[c.trim().toLowerCase()] = (r[i] ?? "").trim()));
          shifts.push(obj);
        }
      }
    } catch {
      /* skip unreadable file */
    }
  }

  if (shifts.length === 0) {
    return toolOk(ID, "Schedule files present but no parseable rows.", {
      data: { connected: true, files, shifts: 0 },
    });
  }

  // Heuristic coverage read: look for a status/calloff column.
  const callOffs = shifts.filter((s) => {
    const v = `${s.status ?? ""} ${s.calloff ?? ""} ${s["call-off"] ?? ""}`.toLowerCase();
    return /call.?off|absent|no.?show|open|uncovered|gap/.test(v);
  });
  const covered = shifts.length - callOffs.length;

  return toolOk(
    ID,
    `${shifts.length} shifts across ${files.length} file(s): ${covered} covered, ${callOffs.length} gaps/call-offs`,
    {
      data: {
        connected: true,
        files,
        totalShifts: shifts.length,
        covered,
        gaps: callOffs.length,
        gapDetail: callOffs.slice(0, 10),
      },
    }
  );
};
