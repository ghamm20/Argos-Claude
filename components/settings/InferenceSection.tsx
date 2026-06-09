"use client";

// components/settings/InferenceSection.tsx
//
// v2.4.2 — operator-facing control for the inference backend switch (Phase A
// shipped the API + routing; this is the Settings UI for it). Drives the
// existing /api/settings fields — no backend changes:
//   - inferenceBackend          global default: "local" (Ollama) | "nous"
//   - perPersonaBackend[persona] override: "local" | "nous" | "default"
//   - nousApiKey                 encrypted at rest, masked on read
//   - useReboundModels           Juniper + Bobby → local gemma-4
//
// The Nous path routes to ONE model only: nvidia/nemotron-3-ultra:free (free
// tier). Selecting "API" with no key configured silently falls back to Local
// (the chat route's documented behavior) — surfaced as a hint here.

import { useCallback, useEffect, useState } from "react";
import { Cloud, Cpu, Eye, EyeOff, Loader2 } from "lucide-react";

type Backend = "local" | "nous";
type PersonaChoice = "local" | "nous" | "default";

interface KeyStatus {
  configured: boolean;
  hint: string | null;
}

const PERSONAS = [
  { id: "bartimaeus", name: "Bartimaeus" },
  { id: "juniper", name: "Juniper" },
  { id: "sage", name: "Sage" },
  { id: "bobby", name: "Bobby" },
] as const;

const NOUS_MODEL = "nvidia/nemotron-3-ultra:free";

export function InferenceSection() {
  const [backend, setBackend] = useState<Backend>("local");
  const [perPersona, setPerPersona] = useState<Record<string, PersonaChoice>>({});
  const [rebound, setRebound] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ configured: false, hint: null });
  const [keyInput, setKeyInput] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        inferenceBackend?: Backend;
        perPersonaBackend?: Record<string, PersonaChoice>;
        useReboundModels?: boolean;
        nousApiKey?: KeyStatus;
      };
      setBackend(j.inferenceBackend === "nous" ? "nous" : "local");
      setPerPersona(j.perPersonaBackend ?? {});
      setRebound(j.useReboundModels === true);
      if (j.nousApiKey) setKeyStatus(j.nousApiKey);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Generic patch → POST /api/settings then refresh. Optimistic local state is
  // already applied by the caller; this persists it.
  const patch = useCallback(
    async (body: Record<string, unknown>, msg: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          setNotice(j.error ?? `save failed (${r.status})`);
          await refresh(); // resync to truth on failure
          return;
        }
        setNotice(msg);
        await refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const chooseBackend = (b: Backend) => {
    setBackend(b);
    void patch({ inferenceBackend: b }, `Global backend → ${b === "nous" ? "API (Nous)" : "Local"}.`);
  };

  const choosePersona = (persona: string, choice: PersonaChoice) => {
    setPerPersona((p) => ({ ...p, [persona]: choice }));
    void patch({ perPersonaBackend: { [persona]: choice } }, "Per-persona backend saved.");
  };

  const toggleRebound = () => {
    const next = !rebound;
    setRebound(next);
    void patch({ useReboundModels: next }, `Rebound models ${next ? "on" : "off"}.`);
  };

  const saveKey = (value: string | null) =>
    patch({ nousApiKey: value }, value ? "Nous key saved + encrypted." : "Nous key cleared.");

  const nousActive =
    backend === "nous" || Object.values(perPersona).some((v) => v === "nous");

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-neutral-200">
        <Cloud size={16} strokeWidth={1.5} className="text-neutral-500" />
        Inference Backend
      </div>
      <p className="mt-1 text-[12px] text-neutral-500 leading-relaxed">
        Route a persona&apos;s chat to the local Ollama daemon or the Nous Research
        API (<span className="font-mono">{NOUS_MODEL}</span>, free tier). USB-native:
        the API is network-<span className="text-neutral-400">optional</span> — selecting
        API with no key falls back to Local silently.
      </p>

      {/* Global backend */}
      <div className="mt-5 rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4">
        <div className="text-[13px] font-medium text-neutral-200">Global default</div>
        <div className="mt-1 text-[11px] text-neutral-500">
          Applies to every persona that isn&apos;t overridden below.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <BackendCard
            active={backend === "local"}
            disabled={busy}
            onClick={() => chooseBackend("local")}
            icon={<Cpu className="h-4 w-4" />}
            title="Local"
            sub="Ollama · on-device"
          />
          <BackendCard
            active={backend === "nous"}
            disabled={busy}
            onClick={() => chooseBackend("nous")}
            icon={<Cloud className="h-4 w-4" />}
            title="API (Nous)"
            sub="Nemotron 3 Ultra · free"
          />
        </div>
      </div>

      {/* Per-persona overrides */}
      <div className="mt-4 rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4">
        <div className="text-[13px] font-medium text-neutral-200">Per-persona override</div>
        <div className="mt-1 text-[11px] text-neutral-500">
          &quot;Default&quot; respects the global setting above.
        </div>
        <div className="mt-3 space-y-2">
          {PERSONAS.map((p) => {
            const cur = perPersona[p.id] ?? "default";
            return (
              <div key={p.id} className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-neutral-300">{p.name}</span>
                <div className="inline-flex rounded-md border border-neutral-800 overflow-hidden">
                  {(["default", "local", "nous"] as PersonaChoice[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      disabled={busy}
                      onClick={() => choosePersona(p.id, c)}
                      className={
                        "px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors disabled:opacity-50 " +
                        (cur === c
                          ? "bg-neutral-700/70 text-neutral-100"
                          : "text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-300")
                      }
                    >
                      {c === "nous" ? "API" : c === "local" ? "Local" : "Default"}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Nous API key */}
      <div className="mt-4 rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-neutral-200">Nous API key</div>
          <StatusPill configured={keyStatus.configured} />
        </div>
        <div className="mt-1 text-[11px] text-neutral-500">
          Required for any &quot;API&quot; route above. Encrypted at rest (AES-256-GCM),
          masked on read, never logged.
          {keyStatus.configured && keyStatus.hint && (
            <> Current: <span className="font-mono text-neutral-400">{keyStatus.hint}</span></>
          )}
        </div>
        <div className="mt-3 relative">
          <input
            type={reveal ? "text" : "password"}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={keyStatus.configured ? "Enter a new key to replace…" : "sk-nous-…"}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md bg-neutral-900/70 border border-neutral-800 px-3 py-2 pr-9 text-[12px] font-mono text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-700"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
            aria-label={reveal ? "Hide key" : "Show key"}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void saveKey(keyInput.trim());
              setKeyInput("");
            }}
            disabled={busy || keyInput.trim().length === 0}
            className="rounded-md border border-emerald-600/50 text-emerald-400 px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-emerald-600/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Save
          </button>
          {keyStatus.configured && (
            <button
              type="button"
              onClick={() => void saveKey(null)}
              disabled={busy}
              className="rounded-md border border-red-700/50 text-red-400 px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-red-600/10 disabled:opacity-40"
            >
              Clear
            </button>
          )}
        </div>
        {nousActive && !keyStatus.configured && (
          <div className="mt-2 text-[11px] text-amber-400/90">
            An API route is selected but no key is set — those personas fall back to Local.
          </div>
        )}
      </div>

      {/* Rebound models flag */}
      <div className="mt-4 rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-neutral-200">Rebound local models</div>
            <div className="mt-1 text-[11px] text-neutral-500">
              Swap Juniper + Bobby to the proven local gemma-4 (already resident
              for Bart/Sage). Separate from the backend switch — a LOCAL change.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={rebound}
            disabled={busy}
            onClick={toggleRebound}
            className={
              "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 " +
              (rebound ? "bg-emerald-600/70" : "bg-neutral-700")
            }
          >
            <span
              className={
                "absolute top-0.5 h-4 w-4 rounded-full bg-neutral-100 transition-transform " +
                (rebound ? "translate-x-4" : "translate-x-0.5")
              }
            />
          </button>
        </div>
      </div>

      {notice && <div className="mt-3 text-[11px] text-neutral-400">{notice}</div>}
    </div>
  );
}

function BackendCard({
  active,
  disabled,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        "rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-50 " +
        (active
          ? "border-emerald-600/60 bg-emerald-600/10"
          : "border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900/70")
      }
    >
      <div className={"flex items-center gap-2 " + (active ? "text-emerald-300" : "text-neutral-300")}>
        {icon}
        <span className="text-[12px] font-medium">{title}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-neutral-500">{sub}</div>
    </button>
  );
}

function StatusPill({ configured }: { configured: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border"
      style={{
        borderColor: configured ? "rgba(16,185,129,0.4)" : "rgba(115,115,115,0.4)",
        color: configured ? "#10b981" : "#a3a3a3",
      }}
    >
      {configured ? "Configured" : "Not set"}
    </span>
  );
}
