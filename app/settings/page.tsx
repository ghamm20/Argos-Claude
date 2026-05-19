import { LeftRail } from "@/components/LeftRail";
import { HUD } from "@/components/HUD";
import { SettingsCenterPane } from "@/components/SettingsCenterPane";
import { CitationDrawer } from "@/components/CitationDrawer";
import { getRuntimeInfo } from "@/lib/runtime-info";

export default async function SettingsPage() {
  const runtime = await getRuntimeInfo();
  const display = runtime.isDev
    ? `${runtime.argosRoot} (dev)`
    : runtime.argosRoot;

  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <SettingsCenterPane runtimeInfo={runtime} />
      <HUD
        argosRoot={display}
        version={runtime.version}
        startedAt={runtime.startedAt}
      />
      <CitationDrawer />
    </main>
  );
}
