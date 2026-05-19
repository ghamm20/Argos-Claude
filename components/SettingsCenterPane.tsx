"use client";

import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";

type SectionId = "model" | "personas" | "vault" | "about";

interface SectionProps {
  id: SectionId;
  label: string;
}

const SECTIONS: SectionProps[] = [
  { id: "model", label: "Model" },
  { id: "personas", label: "Personas" },
  { id: "vault", label: "Vault" },
  { id: "about", label: "About" },
];

export function SettingsCenterPane({
  initialSection,
}: {
  initialSection?: SectionId;
}) {
  const [active, setActive] = useState<SectionId>(initialSection ?? "model");

  return (
    <section className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-10 pt-6 pb-3 border-b border-neutral-800/60">
        <div className="flex items-center gap-2 text-[20px] font-semibold tracking-wide text-neutral-200">
          <SettingsIcon size={18} strokeWidth={1.5} className="text-neutral-500" />
          Settings
        </div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mt-1">
          Local · USB-native · No cloud
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <nav className="w-44 shrink-0 border-r border-neutral-800/50 px-3 py-4 space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              data-settings-section={s.id}
              onClick={() => setActive(s.id)}
              className={
                "w-full text-left rounded-md px-2.5 py-1.5 text-[12px] uppercase tracking-[0.18em] transition-colors " +
                (active === s.id
                  ? "bg-neutral-800/70 text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-300")
              }
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {active === "model" && <ModelSectionPlaceholder />}
          {active === "personas" && <PersonaSectionPlaceholder />}
          {active === "vault" && <VaultSectionPlaceholder />}
          {active === "about" && <AboutSectionPlaceholder />}
        </div>
      </div>
    </section>
  );
}

function ModelSectionPlaceholder() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">Model</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Active model and hardware-aware recommendation.
      </p>
      <div className="text-[12px] text-neutral-600">Wires in commit 4.</div>
    </div>
  );
}
function PersonaSectionPlaceholder() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">Personas</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Default persona at launch.
      </p>
      <div className="text-[12px] text-neutral-600">Wires in commit 5.</div>
    </div>
  );
}
function VaultSectionPlaceholder() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">Vault</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Document index management.
      </p>
      <div className="text-[12px] text-neutral-600">Wires in commit 5.</div>
    </div>
  );
}
function AboutSectionPlaceholder() {
  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">About</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Build info, mount path, network posture.
      </p>
      <div className="text-[12px] text-neutral-600">Wires in commit 5.</div>
    </div>
  );
}
