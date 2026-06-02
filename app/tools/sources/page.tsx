// app/tools/sources/page.tsx
//
// Web Capability TIER 3 (2026-06-02) — Tool & Source discovery dashboard.
// Server shell (LeftRail + HUD) hosting the client SourcesPane.

import { LeftRail } from "@/components/LeftRail";
import { HUD } from "@/components/HUD";
import { SourcesPane } from "@/components/web/SourcesPane";
import { getRuntimeInfo } from "@/lib/runtime-info";

export const dynamic = "force-dynamic";

export default async function ToolSourcesPage() {
  const runtime = await getRuntimeInfo();
  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <SourcesPane />
      <HUD
        argosRoot={runtime.isDev ? `${runtime.argosRoot} (dev)` : runtime.argosRoot}
        version={runtime.version}
        startedAt={runtime.startedAt}
      />
    </main>
  );
}
