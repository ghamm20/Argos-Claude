import { LeftRail } from "@/components/LeftRail";
import { HUD } from "@/components/HUD";
import { SettingsCenterPane } from "@/components/SettingsCenterPane";
import { CitationDrawer } from "@/components/CitationDrawer";
import { argosRoot } from "@/lib/vault/paths";

export default function SettingsPage() {
  const root = argosRoot();
  const display = process.env.ARGOS_ROOT ? root : `${root} (dev)`;

  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <SettingsCenterPane />
      <HUD argosRoot={display} />
      <CitationDrawer />
    </main>
  );
}
