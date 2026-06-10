// app/api/dashboard/route.ts
//
// Stage 6 (2026-06-09) — the progression dashboard's data source. ONE endpoint
// that aggregates every tile from REAL sources; each live number is traceable
// (the `source` field on each tile says where it came from: settings read,
// audit-chain grep, file read, or build-baked value). Off-box systems
// (ParaScope/Oculus/MiroFish) are STUBS from static config — never faked as
// live. No new service, no new port.

import { NextResponse } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { readSettings } from "@/lib/settings";
import { getRuntimeInfo } from "@/lib/runtime-info";
import { computeRollingMetrics } from "@/lib/integrity/stress";
import { readChain } from "@/lib/audit";
import { toolStats } from "@/lib/tools/audit";
import { taskCounts } from "@/lib/tasks/store";
import { getGpuProfile } from "@/lib/gpu/detect";
import { powerModeStatus } from "@/lib/power/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBuildId(root: string): Promise<string | null> {
  try {
    return (await fsp.readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).trim();
  } catch {
    return null;
  }
}

export async function GET() {
  const [rt, settings, integrity, chain, tstats, tasks, gpu] = await Promise.all([
    getRuntimeInfo(),
    readSettings(),
    computeRollingMetrics(),
    readChain().catch(() => []),
    toolStats().catch(() => ({})),
    taskCounts().catch(() => ({ open: 0, completed: 0, cancelled: 0, overdue: 0 })),
    getGpuProfile().catch(() => null),
  ]);

  // Audit-chain kind counts (traceable greps).
  const kindCount: Record<string, number> = {};
  for (const e of chain) kindCount[e.kind] = (kindCount[e.kind] ?? 0) + 1;

  const buildId = await readBuildId(process.cwd());

  // Mirror parity: only the CURRENT instance's BUILD_ID is known USB-natively.
  // Cross-payload parity needs operator-configured roots (ARGOS_PAYLOAD_ROOTS,
  // comma-separated) — NOT hardcoded absolute paths (Seven-Rules Rule 1). When
  // unset, we show this instance only and say so honestly; the deploy/mirror
  // script remains the authority for 5-location parity.
  const payloadRootsEnv = process.env.ARGOS_PAYLOAD_ROOTS?.trim();
  const mirrorRoots = payloadRootsEnv ? payloadRootsEnv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const mirrors = mirrorRoots.length
    ? await Promise.all(mirrorRoots.map(async (r) => ({ root: r, buildId: await readBuildId(r) })))
    : [];
  const mirrorParity =
    mirrors.length === 0
      ? "unconfigured"
      : mirrors.every((m) => m.buildId && m.buildId === buildId)
        ? "in-parity"
        : "DRIFT";

  const agentic = (id: string) => {
    const s = (tstats as Record<string, { count: number; lastAt: string | null }>)[id];
    return { registered: true, uses: s?.count ?? 0, lastAt: s?.lastAt ?? null };
  };

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    tiles: {
      argos: {
        live: true,
        source: "runtime-info (build-baked) + .next/BUILD_ID + integrity metrics log",
        version: rt.version,
        buildId,
        startedAt: rt.startedAt,
        argosRoot: rt.argosRoot,
      },
      integrity: {
        live: true,
        source: "state/integrity-metrics.jsonl (rolling)",
        runs: integrity.runs,
        catchRate7d: integrity.catchRate7d,
        lastCatchRate: integrity.lastCatchRate,
        lastFalsePositiveRate: integrity.lastFalsePositiveRate,
        lastAt: integrity.lastAt,
        misses: integrity.lastMissedIds,
        anyMiss: integrity.anyMissLastRun,
      },
      toolStack: {
        live: true,
        source: "settings.toolExecutionModel + audit-chain greps",
        toolModel: settings.toolExecutionModel,
        useReboundModels: settings.useReboundModels,
        aliasUses: kindCount["tool.param_alias"] ?? 0,
        emailInjectionAttempts: kindCount["email.injection_attempt"] ?? 0,
        egressRedactions: kindCount["chat.egress_redaction"] ?? 0,
      },
      inference: {
        live: true,
        source: "settings.perPersonaBackend + settings.cloudDataPolicy",
        global: settings.inferenceBackend,
        perPersona: settings.perPersonaBackend,
        cloudDataPolicy: settings.cloudDataPolicy,
        nousConfigured: !!settings.nousApiKey,
      },
      agenticTools: {
        live: true,
        source: "state/tool-audit.jsonl (toolStats) + task ledger + settings.gmail",
        file_ops: agentic("file_ops"),
        tasks: { registered: true, ...tasks, created: kindCount["task.created"] ?? 0 },
        email_read: {
          ...agentic("email_read"),
          // Stage 3 deferred-live: dormant until the operator mints a token.
          status: settings.gmail?.refreshToken ? "live" : "built-guarded-dormant (no token)",
        },
      },
      mirrors: {
        live: true,
        source: "this instance .next/BUILD_ID; cross-payload via ARGOS_PAYLOAD_ROOTS (else deploy script is authority)",
        currentBuildId: buildId,
        parity: mirrorParity,
        roots: mirrors,
      },
      gpu: {
        live: true,
        source: "lib/gpu/detect (reuses detectHardware nvidia-smi) + gpu.profile_detected audit",
        name: gpu?.name ?? "unknown",
        vramGb: gpu?.vramGb ?? 0,
        tier: gpu?.tier ?? "lean",
        forced: gpu?.forced ?? false,
        detectionSource: gpu?.source ?? "fallback",
      },
      powerMode: {
        live: true,
        source: "lib/power/mode (detected tier === ample) + gpu.power_mode_available audit",
        ...powerModeStatus(gpu),
      },
    },
    // Off-box systems — STUBS from static config. Status is NOT live; we do not
    // fake liveness for systems that don't run on this box.
    stubs: [
      { name: "ParaScope", kind: "stub", note: "Legal/contract verifier (E:\\ParaScope) — off-box; 91/91 verifier tests last reported.", repo: "local" },
      { name: "Oculus_Osint", kind: "stub", note: "Geospatial OSINT map (CesiumJS, port 3010) — off-box; future ARGOS map pane.", repo: "ghamm20/Oculus_Osint" },
      { name: "MiroFish-Offline", kind: "stub", note: "Social-simulation engine (UI 3001 / Flask 5001 / Neo4j) — off-box.", repo: "local" },
    ],
  });
}
