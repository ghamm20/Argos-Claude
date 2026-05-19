import { LeftRail } from "@/components/LeftRail";
import { ChatPane } from "@/components/ChatPane";
import { HUD } from "@/components/HUD";

export default function Home() {
  const argosRoot = process.env.ARGOS_ROOT || "dev";

  return (
    <main className="h-screen w-screen flex overflow-hidden">
      <LeftRail />
      <ChatPane />
      <HUD argosRoot={argosRoot} />
    </main>
  );
}
