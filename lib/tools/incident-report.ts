// lib/tools/incident-report.ts — T12 Incident Report (approval, reversible)
//
// Formats a structured incident report and writes it to
// ARGOS_ROOT/output/incident-<ts>.md.

import path from "node:path";
import { toolOk, toolErr, type ToolExecute } from "./types";
import { writeOutputFile } from "./util";

export const ID = "incident_report";

const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

export const execute: ToolExecute = async (params) => {
  const description = String(params.description ?? params.incident ?? "").trim();
  if (!description) return toolErr(ID, "incident description is required");
  const location = String(params.location ?? "Unspecified").trim();
  const time = String(params.time ?? new Date().toISOString()).trim();
  const parties = String(params.parties ?? params.partiesInvolved ?? "Unspecified").trim();
  const severityIn = String(params.severity ?? "medium").toLowerCase();
  const severity = SEVERITIES.has(severityIn) ? severityIn.toUpperCase() : "MEDIUM";

  const md = [
    "# Incident Report",
    "",
    `**Generated:** ${new Date().toISOString()}`,
    `**Severity:** ${severity}`,
    `**Time of incident:** ${time}`,
    `**Location:** ${location}`,
    `**Parties involved:** ${parties}`,
    "",
    "## Description",
    "",
    description,
    "",
    "## Next steps",
    "",
    "- [ ] Verify facts with on-site personnel",
    "- [ ] Preserve any evidence / footage",
    "- [ ] Notify the appropriate chain per severity",
    "",
  ].join("\n");

  try {
    const filePath = await writeOutputFile("incident", "md", md);
    return toolOk(ID, `incident report (${severity}) → ${path.basename(filePath)}`, {
      data: { path: filePath, severity, location, time },
    });
  } catch (e) {
    return toolErr(ID, `write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
