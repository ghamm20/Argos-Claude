// lib/tools/mirofish-integration.ts — T18 MiroFish Integration
// (approval; live-system query).
//
// Queries the MiroFish-Offline backend (Flask) for live simulation status +
// entities. The API is the Flask backend on :5001 — NOT the :3001 Vite UI
// (the prior version hit :3001/api/simulation/status + /api/entities, which do
// not exist → 404, misreported as "not running"). Backend surface confirmed
// live (v2.3.10):
//   GET /health                              → { status, service }
//   GET /api/simulation/list                 → { count, data:[{simulation_id,
//                                                 status, current_round, graph_id,
//                                                 entities_count, entity_types}] }
//   GET /api/graph/project/list              → { count, data:[{graph_id, name,...}] }
//   GET /api/simulation/entities/<graph_id>  → { success, data:[{entities:[...],
//                                                 entity_types, total_count}] }
//
// Honesty: a genuine outage returns ok:false with the SPECIFIC reason
// (connection refused vs which endpoint 404'd) — never a blanket "not running".

import { toolOk, toolErr, type ToolExecute, type ToolResult } from "./types";
import { fetchText } from "./util";

export const ID = "mirofish_integration";
// API base — the Flask backend. Override with MIROFISH_API_BASE if remapped.
const BASE = process.env.MIROFISH_API_BASE || "http://127.0.0.1:5001";

interface Json {
  ok: boolean;
  status: number; // 0 = connection-level failure (refused/timeout/DNS)
  data: unknown;
  error: string | null;
}

async function getJson(path: string, timeoutMs = 6000): Promise<Json> {
  const r = await fetchText(`${BASE}${path}`, { timeoutMs });
  if (r.status === 0) {
    // Connection-level: refused, timeout, host unreachable — backend is down.
    return { ok: false, status: 0, data: null, error: r.error || "connection failed" };
  }
  if (!r.ok) {
    // HTTP error (404/500/…): backend up, but this endpoint/path is wrong.
    return { ok: false, status: r.status, data: null, error: `HTTP ${r.status}` };
  }
  try {
    return { ok: true, status: r.status, data: JSON.parse(r.text), error: null };
  } catch {
    return { ok: false, status: r.status, data: null, error: "non-JSON response" };
  }
}

function asArray(d: unknown): Record<string, unknown>[] {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  return [];
}
function dataArray(envelope: unknown): Record<string, unknown>[] {
  // MiroFish list endpoints wrap rows in { count, data:[...] }.
  const e = envelope as { data?: unknown } | null;
  return asArray(e?.data);
}

export const execute: ToolExecute = async (params): Promise<ToolResult> => {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  const endpointParam = typeof params.endpoint === "string" ? params.endpoint.trim() : "";
  const graphIdParam = typeof params.graphId === "string" ? params.graphId.trim() : "";

  // ---- Advanced: direct GET passthrough to a specific backend route ----
  // Only a real backend path (/health or /api/...) is passed through. A
  // non-path hint (e.g. the model improvising endpoint:"status") is NOT a hard
  // error — the standard snapshot below IS the status, so we fall through to it
  // and record the ignored hint for transparency.
  const validEndpoint = endpointParam !== "" && /^\/(health|api\/)/.test(endpointParam);
  let endpointHintIgnored: string | null = null;
  if (validEndpoint) {
    const r = await getJson(endpointParam);
    if (r.status === 0) {
      return toolErr(ID, `MiroFish backend not reachable at ${BASE} (connection refused: ${r.error}). The API is the Flask backend on :5001; :3001 is the Vite UI. Is the mirofish-offline container up?`,
        { data: { connected: false, reason: "connection_refused", base: BASE, endpoint: endpointParam } });
    }
    if (!r.ok) {
      return toolErr(ID, `MiroFish endpoint ${endpointParam} returned ${r.error}. Valid examples: /api/simulation/list, /api/graph/project/list, /api/simulation/entities/<graph_id>.`,
        { data: { connected: true, reason: "endpoint_error", base: BASE, endpoint: endpointParam, httpStatus: r.status } });
    }
    return toolOk(ID, `MiroFish ${endpointParam} → HTTP ${r.status} OK`, {
      data: { connected: true, base: BASE, endpoint: endpointParam, result: r.data },
    });
  } else if (endpointParam !== "") {
    endpointHintIgnored = endpointParam;
  }

  // ---- Standard snapshot: health → simulations → projects → entities ----
  const health = await getJson("/health", 4000);
  if (health.status === 0) {
    return toolErr(
      ID,
      `MiroFish backend not reachable at ${BASE} (connection refused: ${health.error}). The API is the Flask backend on :5001; :3001 is the Vite UI, not the API. Is the mirofish-offline container running?`,
      { data: { connected: false, reason: "connection_refused", base: BASE } }
    );
  }
  if (!health.ok) {
    return toolErr(
      ID,
      `MiroFish /health returned ${health.error} at ${BASE} — backend reachable but unhealthy/misconfigured.`,
      { data: { connected: false, reason: "unhealthy", base: BASE, httpStatus: health.status } }
    );
  }

  // Backend is up. Pull the real state.
  const [sims, projects] = await Promise.all([
    getJson("/api/simulation/list"),
    getJson("/api/graph/project/list"),
  ]);

  const simItems = sims.ok ? dataArray(sims.data) : [];
  const projItems = projects.ok ? dataArray(projects.data) : [];

  // Resolve the graph to inspect for entities: explicit param > newest sim >
  // newest project.
  const activeGraphId =
    graphIdParam ||
    (simItems.find((s) => typeof s.graph_id === "string")?.graph_id as string | undefined) ||
    (projItems.find((p) => typeof p.graph_id === "string")?.graph_id as string | undefined) ||
    "";

  // The simulation record matching the active graph is AUTHORITATIVE for the
  // entity count + types (already fetched in /api/simulation/list). The detail
  // endpoint (names/uuids) is best-effort: it can return an empty bundle
  // transiently while that graph's simulation is actively running. So the count
  // is sourced from the sim record (never under-reported), and names are a
  // best-effort enrichment with one retry.
  const activeSim =
    simItems.find((s) => s.graph_id === activeGraphId) || simItems[0] || null;
  const simEntityCount =
    activeSim && typeof activeSim.entities_count === "number"
      ? (activeSim.entities_count as number)
      : null;
  const simEntityTypes =
    activeSim && Array.isArray(activeSim.entity_types) ? (activeSim.entity_types as string[]) : [];

  let entities: {
    graphId: string;
    count: number | null;
    total_count: number | null;
    filtered_count: number | null;
    entity_types: string[];
    items: { name: unknown; labels: unknown; summary: unknown; uuid: unknown }[];
    detailAvailable: boolean;
    detailError: string | null;
  } | null = null;

  if (activeGraphId) {
    let bundle: Record<string, unknown> = {};
    let detailError: string | null = null;
    // Up to 2 attempts: tolerate a transient empty bundle under sim contention.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ed = await getJson(`/api/simulation/entities/${encodeURIComponent(activeGraphId)}`, 8000);
      if (!ed.ok) {
        detailError = ed.status === 0 ? `connection failed: ${ed.error}` : ed.error || "fetch failed";
        continue;
      }
      detailError = null;
      const b = (dataArray(ed.data)[0] ?? {}) as Record<string, unknown>;
      if (asArray(b.entities).length > 0 || typeof b.total_count === "number") {
        bundle = b;
        break;
      }
      // 200 OK but an empty bundle — retry once before giving up on detail.
      detailError = "endpoint returned an empty bundle";
    }
    const rawEntities = asArray(bundle.entities);
    const detailTotal = typeof bundle.total_count === "number" ? bundle.total_count : null;
    const detailFiltered = typeof bundle.filtered_count === "number" ? bundle.filtered_count : null;
    entities = {
      graphId: activeGraphId,
      // Authoritative count: sim record first, then the endpoint's filtered/total.
      count: simEntityCount ?? detailFiltered ?? detailTotal,
      total_count: detailTotal,
      filtered_count: detailFiltered,
      entity_types:
        Array.isArray(bundle.entity_types) && (bundle.entity_types as unknown[]).length
          ? (bundle.entity_types as string[])
          : simEntityTypes,
      // Cap to keep the payload lean; identity-level fields only.
      items: rawEntities.slice(0, 25).map((e) => ({
        name: e.name ?? null,
        labels: e.labels ?? null,
        summary: e.summary ?? null,
        uuid: e.uuid ?? null,
      })),
      detailAvailable: rawEntities.length > 0,
      detailError: rawEntities.length > 0 ? null : detailError,
    };
  }

  // ---- Build an honest, specific summary ----
  const parts: string[] = [`MiroFish online (${BASE.replace(/^https?:\/\//, "")})`];
  parts.push(`${simItems.length} simulation${simItems.length === 1 ? "" : "s"}`);
  if (simItems.length > 0) {
    const s = simItems[0];
    const st = typeof s.status === "string" ? s.status : "unknown";
    const round = typeof s.current_round === "number" ? s.current_round : "?";
    parts.push(`latest: ${st} (round ${round})`);
  }
  parts.push(`${projItems.length} project${projItems.length === 1 ? "" : "s"}`);
  if (entities) {
    const names = entities.items.map((e) => (typeof e.name === "string" ? e.name : null)).filter(Boolean);
    const n = entities.count;
    let frag = `graph ${activeGraphId.slice(0, 8)}…: ${n ?? "?"} entit${n === 1 ? "y" : "ies"}`;
    if (entities.entity_types.length) frag += ` (${entities.entity_types.join(", ")})`;
    if (names.length) frag += ` — ${names.slice(0, 6).join(", ")}`;
    else if (n && n > 0) frag += ` — name detail unavailable${entities.detailError ? ` (${entities.detailError})` : ""}`;
    parts.push(frag);
  }
  // Note any partial failure of the list endpoints (backend up but a route failed).
  const partial: string[] = [];
  if (!sims.ok) partial.push(`simulation/list ${sims.error}`);
  if (!projects.ok) partial.push(`graph/project/list ${projects.error}`);
  if (partial.length) parts.push(`(partial: ${partial.join("; ")})`);

  return toolOk(ID, parts.join(". ") + ".", {
    data: {
      connected: true,
      base: BASE,
      query: query || null,
      endpointHintIgnored,
      health: health.data,
      simulations: {
        count: simItems.length,
        items: simItems.map((s) => ({
          simulation_id: s.simulation_id ?? null,
          status: s.status ?? null,
          current_round: s.current_round ?? null,
          graph_id: s.graph_id ?? null,
          entities_count: s.entities_count ?? null,
          entity_types: s.entity_types ?? null,
        })),
      },
      projects: {
        count: projItems.length,
        items: projItems.map((p) => ({
          graph_id: p.graph_id ?? null,
          name: p.name ?? null,
        })),
      },
      activeGraphId: activeGraphId || null,
      entities,
    },
  });
};
