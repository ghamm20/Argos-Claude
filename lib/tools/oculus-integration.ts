// lib/tools/oculus-integration.ts — T17 Oculus0Osint Integration
// (approval; live-system query).
//
// Queries Oculus0Osint on 127.0.0.1:3010 for the live entity feed + camera
// list. Graceful when not running.

import { toolOk, type ToolExecute } from "./types";
import { fetchText } from "./util";

export const ID = "oculus_integration";
const BASE = "http://127.0.0.1:3010";
const NOT_RUNNING = "Oculus not running. Start it on port 3010 to enable.";

async function getJson(url: string): Promise<{ ok: boolean; data: unknown }> {
  const r = await fetchText(url, { timeoutMs: 3000 });
  if (!r.ok || !r.text) return { ok: false, data: null };
  try {
    return { ok: true, data: JSON.parse(r.text) };
  } catch {
    return { ok: false, data: null };
  }
}

export const execute: ToolExecute = async () => {
  const entities = await getJson(`${BASE}/api/entities`);
  const cameras = await getJson(`${BASE}/api/cameras`);
  if (!entities.ok && !cameras.ok) {
    return toolOk(ID, NOT_RUNNING, { data: { connected: false, note: NOT_RUNNING } });
  }
  return toolOk(ID, "Oculus connected — live feed retrieved", {
    data: {
      connected: true,
      entities: entities.ok ? entities.data : null,
      cameras: cameras.ok ? cameras.data : null,
    },
  });
};
