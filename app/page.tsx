import { LeftRail } from "@/components/LeftRail";
import { HUD } from "@/components/HUD";
import { CenterPane } from "@/components/CenterPane";
import { CitationDrawer } from "@/components/CitationDrawer";
import { getRuntimeInfo } from "@/lib/runtime-info";

export default async function Home() {
  const runtime = await getRuntimeInfo();
  const display = runtime.isDev
    ? `${runtime.argosRoot} (dev)`
    : runtime.argosRoot;

  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <CenterPane />
      <HUD
        argosRoot={display}
        version={runtime.version}
        startedAt={runtime.startedAt}
      />
      <CitationDrawer />
    </main>
  );
}
