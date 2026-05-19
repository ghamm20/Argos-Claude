"use client";

import { PERSONAS } from "@/lib/personas";
import { useArgos, type Tab } from "@/lib/store";
import {
  MessageSquare,
  FolderArchive,
  Eye as EyeIcon,
  Mic,
  Database,
  Wrench,
} from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  icon: typeof MessageSquare;
  active: boolean;
  tab?: Tab;
}

const NAV: NavItem[] = [
  { id: "chat", label: "Chat", icon: MessageSquare, active: true, tab: "chat" },
  { id: "vault", label: "Vault", icon: FolderArchive, active: true, tab: "vault" },
  { id: "vision", label: "Vision", icon: EyeIcon, active: false },
  { id: "voice", label: "Voice", icon: Mic, active: false },
  { id: "memory", label: "Memory", icon: Database, active: false },
  { id: "tools", label: "Tools", icon: Wrench, active: false },
];

const WORKSPACES = [
  { id: "operator", label: "Operator", active: true },
  { id: "analyst", label: "Analyst", active: false },
  { id: "researcher", label: "Researcher", active: false },
];

export function LeftRail() {
  const currentPersonaId = useArgos((s) => s.currentPersonaId);
  const switchPersona = useArgos((s) => s.switchPersona);
  const currentTab = useArgos((s) => s.currentTab);
  const setTab = useArgos((s) => s.setTab);

  return (
    <aside className="w-[240px] shrink-0 border-r border-neutral-800/80 bg-black/30 flex flex-col">
      <div className="px-5 py-5 border-b border-neutral-800/80">
        <div className="text-[22px] font-semibold tracking-[0.18em] text-neutral-100">
          ARGOS
        </div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mt-1">
          Local · USB-native
        </div>
      </div>

      <div className="px-4 py-4 border-b border-neutral-800/80">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 mb-2">
          Persona
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PERSONAS.map((p) => {
            const selected = currentPersonaId === p.id;
            return (
              <button
                key={p.id}
                data-persona={p.id}
                onClick={() => switchPersona(p.id)}
                className="group relative rounded-md border px-2.5 py-2 text-left transition-colors"
                style={{
                  borderColor: selected ? p.eyeColor : "rgba(64,64,64,0.6)",
                  background: selected
                    ? `${p.eyeColor}14`
                    : "rgba(20,20,20,0.6)",
                }}
                title={p.description}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: p.eyeColor }}
                  />
                  <span className="text-[12px] font-medium text-neutral-200">
                    {p.name}
                  </span>
                </div>
                <div className="text-[9px] uppercase tracking-wider text-neutral-500 mt-1">
                  {p.status}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 px-2 mb-2">
          Workspace
        </div>
        {NAV.map((n) => {
          const Icon = n.icon;
          const isSelected = n.active && n.tab && n.tab === currentTab;
          return (
            <button
              key={n.id}
              data-nav={n.id}
              disabled={!n.active}
              onClick={() => {
                if (n.active && n.tab) setTab(n.tab);
              }}
              className={
                "w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-[13px] transition-colors " +
                (n.active
                  ? isSelected
                    ? "bg-neutral-800/80 text-neutral-100"
                    : "text-neutral-300 hover:bg-neutral-900/60"
                  : "text-neutral-500 hover:bg-neutral-900/50 cursor-not-allowed")
              }
            >
              <span className="flex items-center gap-2">
                <Icon size={14} strokeWidth={1.75} />
                {n.label}
              </span>
              {!n.active && (
                <span className="text-[9px] uppercase tracking-wider rounded-sm border border-neutral-700 px-1 py-0.5 text-neutral-500">
                  v2
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-3 py-3 border-t border-neutral-800/80">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 px-2 mb-2">
          Mode
        </div>
        <div className="space-y-1">
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              disabled={!w.active}
              className={
                "w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-[12px] " +
                (w.active
                  ? "bg-neutral-800/60 text-neutral-200"
                  : "text-neutral-600 cursor-not-allowed")
              }
            >
              {w.label}
              {!w.active && (
                <span className="text-[9px] uppercase tracking-wider rounded-sm border border-neutral-700 px-1 py-0.5 text-neutral-500">
                  v2
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
