// src/app/api/tools/status/route.ts
// Returns live health status for all registered ARGOS tools
// Used by the ToolsDock component

import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { argosRoot } from '@/lib/vault/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ToolEntry {
  id: string;
  name: string;
  description: string;
  port: number | null;
  healthUrl: string | null;
  autoStart: boolean;
  openInBrowser: boolean;
  icon: string;
  category: string;
  status: string;
  notes: string;
}

interface ToolStatus extends ToolEntry {
  online: boolean;
  latencyMs: number | null;
  checkedAt: string;
}

async function checkHealth(url: string): Promise<{ online: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    });
    return { online: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { online: false, latencyMs: Date.now() - start };
  }
}

export async function GET() {
  try {
    // Resolve the registry from ARGOS_ROOT (consistent with the rest of
    // ARGOS via the shared helper, not an ad-hoc cwd walk).
    const registryPath = resolve(argosRoot(), 'tools', 'registry.json');

    // GRACEFUL: a missing or unreadable registry is NOT an error — the
    // operator simply hasn't populated tools yet. Return an empty list with
    // 200 so the TOOLS dock renders cleanly ("0/0 ONLINE") instead of
    // surfacing a "Registry error" banner. (Fixes the TOOLS-section error
    // when tools/registry.json is absent.)
    let registry: { tools: ToolEntry[] };
    if (!existsSync(registryPath)) {
      return NextResponse.json({ tools: [], registryMissing: true });
    }
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    } catch {
      return NextResponse.json({ tools: [], registryUnreadable: true });
    }
    if (!registry || !Array.isArray(registry.tools)) {
      return NextResponse.json({ tools: [], registryInvalid: true });
    }

    // Health-check all tools in parallel
    const results: ToolStatus[] = await Promise.all(
      registry.tools.map(async (tool) => {
        if (!tool.healthUrl || tool.status === 'foundation') {
          return {
            ...tool,
            online: false,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
          };
        }
        const { online, latencyMs } = await checkHealth(tool.healthUrl);
        return {
          ...tool,
          online,
          latencyMs,
          checkedAt: new Date().toISOString(),
        };
      })
    );

    return NextResponse.json({ tools: results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
