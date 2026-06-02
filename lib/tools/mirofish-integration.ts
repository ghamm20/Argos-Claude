// lib/tools/mirofish-integration.ts — T18 MiroFish Integration
// (approval; live-system query).
//
// Queries MiroFish on 127.0.0.1:3001 for simulation status + entities.
// Graceful when not running.

import { toolOk, type ToolExecute } from "./types";
import { fetchText } from "./util";

export const ID = "mirofish_integration";
const BASE = "http://127.0.0.1:3001";
const NOT_RUNNING = "MiroFish not running. Start it on port 3001 to enable.";

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
  const status = await getJson(`${BASE}/api/simulation/status`);
  const entities = await getJson(`${BASE}/api/entities`);
  if (!status.ok && !entities.ok) {
    return toolOk(ID, NOT_RUNNING, { data: { connected: false, note: NOT_RUNNING } });
  }
  return toolOk(ID, "MiroFish connected — simulation status retrieved", {
    data: {
      connected: true,
      status: status.ok ? status.data : null,
      entities: entities.ok ? entities.data : null,
    },
  });
};
