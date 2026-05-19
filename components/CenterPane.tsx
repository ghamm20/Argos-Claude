"use client";

import { useArgos } from "@/lib/store";
import { ChatPane } from "./ChatPane";
import { VaultPanel } from "./VaultPanel";

export function CenterPane() {
  const tab = useArgos((s) => s.currentTab);
  return tab === "vault" ? <VaultPanel /> : <ChatPane />;
}
