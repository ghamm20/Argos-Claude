"use client";

import { useEffect, useState } from "react";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { useArgos } from "@/lib/store";

export function PersonaSection() {
  const currentPersonaId = useArgos((s) => s.currentPersonaId);
  const switchPersona = useArgos((s) => s.switchPersona);
  const [defaultPersona, setDefaultPersona] = useState<PersonaId | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { defaultPersona: PersonaId };
        if (!cancel) setDefaultPersona(j.defaultPersona);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function pick(id: PersonaId) {
    setDefaultPersona(id);
    switchPersona(id);
    setSaveState("saving");
    setError(null);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultPersona: id }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${r.status}`);
        setSaveState("error");
        return;
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaveState("error");
    }
  }

  return (
    <div>
      <h2 className="text-[15px] font-medium text-neutral-100 mb-1">Personas</h2>
      <p className="text-[12px] text-neutral-500 mb-6">
        Default persona at launch. Saved to <span className="font-mono">$ARGOS_ROOT/config/settings.json</span>.
      </p>

      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mb-2">
        Default persona{" "}
        {defaultPersona ? (
          <span className="text-neutral-400 normal-case tracking-normal">
            (currently: {defaultPersona})
          </span>
        ) : null}
      </div>
      <div className="space-y-2">
        {PERSONAS.map((p) => {
          const isDefault = defaultPersona === p.id;
          const isActive = currentPersonaId === p.id;
          return (
            <label
              key={p.id}
              data-testid={`persona-option-${p.id}`}
              className="block rounded-md border px-3 py-2.5 cursor-pointer transition-colors"
              style={{
                borderColor: isDefault ? p.eyeColor : "rgba(64,64,64,0.6)",
                background: isDefault
                  ? `${p.eyeColor}14`
                  : "rgba(10,10,10,0.4)",
              }}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="default-persona"
                  value={p.id}
                  checked={isDefault}
                  onChange={() => void pick(p.id)}
                  className="mt-1 accent-neutral-300"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: p.eyeColor }}
                    />
                    <span className="text-[13px] font-medium text-neutral-100">
                      {p.name}
                    </span>
                    {isActive && (
                      <span className="text-[9px] uppercase tracking-[0.18em] text-neutral-500 border border-neutral-700 rounded-sm px-1.5 py-0.5">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-1 leading-relaxed">
                    {p.description}
                  </div>
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div className="mt-4 text-[10px] uppercase tracking-[0.18em] text-neutral-600 min-h-[14px]">
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved."}
        {saveState === "error" && (
          <span className="text-red-400">Save failed: {error}</span>
        )}
      </div>
    </div>
  );
}
