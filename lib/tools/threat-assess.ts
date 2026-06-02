// lib/tools/threat-assess.ts — T14 Threat Assessment (safe)
//
// Uses the security-triage + threat-assessment skills with Bartimaeus's model
// to produce a calibrated assessment (severity / likelihood / confidence).
// Optionally saves the report to output/ when the operator requests it.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { toolOk, toolErr, type ToolExecute } from "./types";
import { callModel, writeOutputFile } from "./util";
import { argosRoot } from "../vault/paths";
import { PERSONA_BY_ID } from "../personas";

export const ID = "threat_assess";

async function loadSkills(): Promise<string> {
  const names = ["threat-assessment.md", "security-triage.md"];
  const parts: string[] = [];
  for (const n of names) {
    try {
      parts.push(await fsp.readFile(path.join(argosRoot(), "skills", n), "utf8"));
    } catch {
      /* skill missing — proceed without it */
    }
  }
  return parts.join("\n\n");
}

export const execute: ToolExecute = async (params, ctx) => {
  const location = String(params.location ?? "Unspecified").trim();
  const situation = String(params.situation ?? params.threats ?? "").trim();
  const assets = String(params.assets ?? "Unspecified").trim();
  const threats = String(params.threats ?? "").trim();
  if (!situation && !threats) {
    return toolErr(ID, "situation or threats is required");
  }

  const model = ctx.model || PERSONA_BY_ID.bartimaeus.model;
  const skills = await loadSkills();
  const system =
    "You are a security threat analyst. Use the skills below to produce a calibrated assessment.\n\n" +
    skills +
    "\n\nProduce: Severity (INFO/LOW/MEDIUM/HIGH/CRITICAL), Likelihood (unlikely/possible/likely/confirmed), Confidence (low/moderate/high), the 'so what', and the single decisive next step.";
  const user = [
    `Location: ${location}`,
    `Assets: ${assets}`,
    `Situation: ${situation}`,
    threats ? `Threats: ${threats}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let assessment: string;
  try {
    assessment = await callModel(model, system, user, { timeoutMs: 120_000, signal: ctx.signal });
  } catch (e) {
    return toolErr(ID, `assessment failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let savedPath: string | null = null;
  if (params.save === true) {
    try {
      savedPath = await writeOutputFile(
        `threat-assessment-${location}`,
        "md",
        `# Threat Assessment — ${location}\n\n${assessment}\n`
      );
    } catch {
      /* save best-effort */
    }
  }

  return toolOk(ID, `threat assessment for ${location}${savedPath ? " (saved)" : ""}`, {
    data: { location, assessment, savedPath },
  });
};
