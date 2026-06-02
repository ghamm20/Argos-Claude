// lib/web/disabled.ts
//
// Web Capability TIER 3 (2026-06-02) — operator-controlled per-source kill
// switch. Disabled sources are persisted to state/web-disabled.json and
// ENFORCED in webFetch() (a disabled source never makes a network call; it
// returns a graceful "disabled by operator" and is audited). Cached in-memory
// for a few seconds so the hot path doesn't read the file every call.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "../vault/paths";

function disabledPath(): string {
  return path.join(argosRoot(), "state", "web-disabled.json");
}

let cache: { at: number; set: Set<string> } | null = null;
const TTL_MS = 4000;

async function load(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  let set = new Set<string>();
  try {
    const raw = await fsp.readFile(disabledPath(), "utf8");
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) set = new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    /* none disabled */
  }
  cache = { at: Date.now(), set };
  return set;
}

export async function isDisabled(source: string): Promise<boolean> {
  return (await load()).has(source);
}

export async function listDisabled(): Promise<string[]> {
  return [...(await load())];
}

export async function setDisabled(source: string, disabled: boolean): Promise<string[]> {
  const set = new Set(await listDisabled());
  if (disabled) set.add(source);
  else set.delete(source);
  const final = disabledPath();
  const tmp = `${final}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(final), { recursive: true });
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify([...set]), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
  cache = { at: Date.now(), set };
  return [...set];
}
