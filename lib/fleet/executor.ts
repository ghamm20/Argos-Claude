// lib/fleet/executor.ts
//
// Stage 10 (2026-06-09) — FLEET COMMAND. A remote-executor backend (the
// inference-backend pattern extended with a tailnet Ollama endpoint): dispatch
// drafting/coding work to a remote rig's models, results returned THROUGH the
// ARGOS pipeline (audit + the Judge pass). The tailnet is trusted-ER, not
// trusted: per the endpoint policy, vault/memory stay home (default redacted);
// email content NEVER leaves regardless.
//
// GRACEFUL DEFERRAL: if the endpoint is unreachable (the rig isn't on the
// tailnet yet), the dispatch DEFERS with a fleet_endpoint_deferred audit and a
// clean { deferred:true } result — never a dead-endpoint error swallowed
// silently. Real fleet wiring is a one-config-line activation once the rig is up.

import { appendAudit } from "../audit";
import { readSettings, type FleetEndpoint } from "../settings";
import { makeClaim, recordClaim, recordOutcome } from "../verifier/schema";
import { judgeClaim } from "../verifier/judge";

export interface ProbeResult {
  reachable: boolean;
  models: string[];
  error?: string;
}

/** Probe a remote Ollama endpoint (GET /api/tags), 4s budget. Never throws. */
export async function probeEndpoint(baseUrl: string): Promise<ProbeResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) return { reachable: false, models: [], error: `tags ${res.status}` };
      const j = (await res.json()) as { models?: Array<{ name?: string }> };
      return { reachable: true, models: (j.models ?? []).map((m) => m.name ?? "").filter(Boolean) };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { reachable: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface FleetDispatchResult {
  ok: boolean;
  deferred: boolean;
  endpointId: string | null;
  baseUrl: string | null;
  model: string | null;
  content: string;
  claimId: string | null;
  verdict: string | null;
  latencyMs: number;
  reason: string;
}

/**
 * Dispatch a self-contained drafting/coding task to a fleet endpoint. The task
 * is sent ALONE (no vault/memory/email) — local context redaction is moot for
 * v1 self-contained tasks, and the per-endpoint policy governs anything richer.
 * The result is wrapped in a Claim and judged.
 */
export async function dispatchToFleet(opts: {
  task: string;
  endpointId?: string;
  model?: string;
}): Promise<FleetDispatchResult> {
  const start = Date.now();
  const settings = await readSettings().catch(() => null);
  const endpoints = settings?.fleet?.endpoints ?? [];
  const ep: FleetEndpoint | undefined = opts.endpointId
    ? endpoints.find((e) => e.id === opts.endpointId)
    : endpoints[0];

  if (!ep) {
    await appendAudit("fleet_endpoint_deferred", { reason: "no fleet endpoint configured", endpointId: opts.endpointId ?? null }).catch(() => {});
    return { ok: false, deferred: true, endpointId: null, baseUrl: null, model: null, content: "", claimId: null, verdict: null, latencyMs: Date.now() - start, reason: "no fleet endpoint configured — deferred" };
  }

  const probe = await probeEndpoint(ep.baseUrl);
  if (!probe.reachable) {
    await appendAudit("fleet_endpoint_deferred", { endpointId: ep.id, baseUrl: ep.baseUrl, reason: `unreachable: ${probe.error}` }).catch(() => {});
    return { ok: false, deferred: true, endpointId: ep.id, baseUrl: ep.baseUrl, model: null, content: "", claimId: null, verdict: null, latencyMs: Date.now() - start, reason: `endpoint ${ep.id} unreachable (${probe.error}) — deferred` };
  }

  const model = opts.model || probe.models[0] || "";
  if (!model) {
    await appendAudit("fleet_endpoint_deferred", { endpointId: ep.id, reason: "endpoint has no models" }).catch(() => {});
    return { ok: false, deferred: true, endpointId: ep.id, baseUrl: ep.baseUrl, model: null, content: "", claimId: null, verdict: null, latencyMs: Date.now() - start, reason: "endpoint has no models — deferred" };
  }

  let content = "";
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: opts.task }], stream: false, think: false }),
    });
    if (!res.ok) throw new Error(`chat ${res.status}`);
    const j = (await res.json()) as { message?: { content?: string } };
    content = (j.message?.content ?? "").trim();
  } catch (e) {
    await appendAudit("fleet.dispatch", { endpointId: ep.id, model, ok: false, error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    return { ok: false, deferred: false, endpointId: ep.id, baseUrl: ep.baseUrl, model, content: "", claimId: null, verdict: null, latencyMs: Date.now() - start, reason: `dispatch failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Result returns THROUGH the ARGOS pipeline: audited + wrapped in a Claim for
  // the Judge (a draft's quality is model-judged, not mechanical).
  await appendAudit("fleet.dispatch", { endpointId: ep.id, model, ok: true, chars: content.length, latencyMs: Date.now() - start }).catch(() => {});
  const claim = makeClaim(`fleet:${ep.id}`, `fleet ${ep.id} (${model}) returned a non-empty draft for the task`, content.length > 0 ? { type: "none" } : { type: "file_exists", path: "__never__" });
  await recordClaim(claim);
  const outcome = await judgeClaim(claim);
  await recordOutcome(outcome);

  return { ok: true, deferred: false, endpointId: ep.id, baseUrl: ep.baseUrl, model, content, claimId: claim.id, verdict: outcome.verdict, latencyMs: Date.now() - start, reason: "dispatched + judged" };
}
