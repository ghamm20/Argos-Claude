// src/app/api/tools/status/route.ts
// Returns live health status for all registered ARGOS tools
// Used by the ToolsDock component

import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
    // Load registry — resolve from ARGOS_ROOT env or relative path
    const argosRoot = process.env.ARGOS_ROOT ?? resolve(process.cwd(), '..', '..');
    const registryPath = resolve(argosRoot, 'tools', 'registry.json');

    let registry: { tools: ToolEntry[] };
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    } catch {
      return NextResponse.json(
        { error: 'Could not read tools/registry.json', path: registryPath },
        { status: 500 }
      );
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
