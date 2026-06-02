"use client";

import { useRouter, usePathname } from "next/navigation";
import { PERSONAS } from "@/lib/personas";
import { useArgos, type Tab } from "@/lib/store";
import {
  MessageSquare,
  FolderArchive,
  Eye as EyeIcon,
  Mic,
  Database,
  Wrench,
  Settings,
} from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  icon: typeof MessageSquare;
  active: boolean;
  tab?: Tab;
  route?: string;
  stub?: boolean;
}

const NAV: NavItem[] = [
  { id: "chat", label: "Chat", icon: MessageSquare, active: true, tab: "chat" },
  { id: "vault", label: "Vault", icon: FolderArchive, active: true, tab: "vault" },
  // Vision Phase 1 (2026-06-02) — Vision is now a real feature (image drop,
  // file vision, screenshot). No longer a stub → no v2 label.
  { id: "vision", label: "Vision", icon: EyeIcon, active: true, route: "/vision" },
  { id: "voice", label: "Voice", icon: Mic, active: true, route: "/voice", stub: true },
  { id: "memory", label: "Memory", icon: Database, active: true, route: "/memory", stub: true },
  { id: "tools", label: "Tools", icon: Wrench, active: true, route: "/tools", stub: true },
  { id: "settings", label: "Settings", icon: Settings, active: true, route: "/settings" },
];

interface Workspace {
  id: string;
  label: string;
  active: boolean;
  note?: string;
}

const WORKSPACE_V2_NOTE =
  "Workspaces ship in v2. v1 runs in Operator only. See docs/02-SCOPE-LOCK.md.";

const WORKSPACES: Workspace[] = [
  { id: "operator", label: "Operator", active: true },
  { id: "research", label: "Research", active: false, note: WORKSPACE_V2_NOTE },
  { id: "strategy", label: "Strategy", active: false, note: WORKSPACE_V2_NOTE },
  { id: "theology", label: "Theology", active: false, note: WORKSPACE_V2_NOTE },
  { id: "writing", label: "Writing", active: false, note: WORKSPACE_V2_NOTE },
  { id: "survival", label: "Survival", active: false, note: WORKSPACE_V2_NOTE },
  { id: "coding", label: "Coding", active: false, note: WORKSPACE_V2_NOTE },
];

export function LeftRail() {
  const currentPersonaId = useArgos((s) => s.currentPersonaId);
  const switchPersona = useArgos((s) => s.switchPersona);
  const currentTab = useArgos((s) => s.currentTab);
  const setTab = useArgos((s) => s.setTab);
  const router = useRouter();
  const pathname = usePathname();
  const onSettings = pathname?.startsWith("/settings") ?? false;

  function handleNav(n: NavItem) {
    if (!n.active) return;
    if (n.route) {
      router.push(n.route);
      return;
    }
    if (n.tab) {
      if (onSettings) {
        // navigate back to root, then set tab
        setTab(n.tab);
        router.push("/");
      } else {
        setTab(n.tab);
      }
    }
  }

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
          const isRoute = !!n.route;
          const isSelected = n.active && (
            isRoute
              ? pathname === n.route ||
                (n.route !== "/" && pathname?.startsWith(`${n.route}/`))
              : !onSettings && n.tab && n.tab === currentTab
          );
          return (
            <button
              key={n.id}
              data-nav={n.id}
              data-nav-stub={n.stub ? "true" : undefined}
              disabled={!n.active}
              onClick={() => handleNav(n)}
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
              {(n.stub || !n.active) && (
                <span className="text-[9px] uppercase tracking-wider rounded-sm border border-amber-500/40 text-amber-400 bg-amber-500/5 px-1 py-0.5">
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
              data-workspace={w.id}
              data-workspace-active={w.active ? "true" : "false"}
              disabled={!w.active}
              title={w.note ?? undefined}
              onClick={(e) => {
                if (!w.active) e.preventDefault();
              }}
              className={
                "w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-[12px] transition-colors " +
                (w.active
                  ? "bg-neutral-800/60 text-neutral-200"
                  : "text-neutral-600 cursor-not-allowed hover:bg-neutral-900/40")
              }
            >
              {w.label}
              {!w.active && (
                <span className="text-[9px] uppercase tracking-wider rounded-sm border border-amber-500/40 text-amber-400 bg-amber-500/5 px-1 py-0.5">
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
