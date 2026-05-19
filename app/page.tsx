import { LeftRail } from "@/components/LeftRail";
import { HUD } from "@/components/HUD";
import { CenterPane } from "@/components/CenterPane";
import { argosRoot } from "@/lib/vault/paths";

export default function Home() {
  const root = argosRoot();
  const display = process.env.ARGOS_ROOT ? root : `${root} (dev)`;

  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <CenterPane />
      <HUD argosRoot={display} />
    </main>
  );
}
