import { create } from "zustand";
import { PERSONA_BY_ID, isPersonaSelectable, type PersonaId } from "./personas";

export type ChatRole = "user" | "assistant" | "system";
export type Tab = "chat" | "vault";

export interface CitedHit {
  index: number;
  text: string;
  filename: string;
  chunkIndex: number;
  score: number;
  /** Phase 3: bucketed confidence — "high" | "medium" | "low".
   *  Optional for back-compat with persisted sessions that don't carry it. */
  confidence?: "high" | "medium" | "low";
  docId: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  personaId?: PersonaId;
  retrievalHits?: CitedHit[];
  retrievalError?: string | null;
  isStreaming?: boolean;
  errored?: boolean;
}

export interface HudMetrics {
  latencyMs: number;
  tokensPerSec: number;
  totalTokens: number;
  timeToFirstTokenMs: number;
  p50LatencyMs: number;
  recentLatencies: number[];
}

export interface VaultStatus {
  docs: number;
  chunks: number;
  ingesting: string | null;
}

const EMPTY_METRICS: HudMetrics = {
  latencyMs: 0,
  tokensPerSec: 0,
  totalTokens: 0,
  timeToFirstTokenMs: 0,
  p50LatencyMs: 0,
  recentLatencies: [],
};

const EMPTY_VAULT: VaultStatus = {
  docs: 0,
  chunks: 0,
  ingesting: null,
};

// Phase 2-RB (2026-05-24): roster reset to match the actual Ollama
// store on this machine. The owner wiped the previous 4-model roster
// down to two models; validation harness confirmed both are stable on
// the RTX 3060 Ti / 8 GB VRAM hardware envelope.
//
// Bart (live default) → e4b:latest             (gemma4 7.5B Q4_K_M, 5.3 GB)
// Bobby (selectable)  → gemma2-2b-local:latest (gemma2 2B,           1.7 GB)
// Juniper             → not_configured (model not in store)
// Sage                → not_configured (model not in store)
//
// See PHASE_2_MODEL_VALIDATION.md for the measurement detail and
// methodology/decisions.md for the rationale.
const DEFAULT_MODEL = "e4b:latest";
export const AVAILABLE_MODELS: readonly string[] = [
  "e4b:latest",                // Bartimaeus (validated, primary)
  "gemma2-2b-local:latest",    // Bobby (validated fallback)
] as const;
export function isAvailableModel(m: string): boolean {
  return AVAILABLE_MODELS.includes(m);
}

/**
 * Phase 2-RB model-swap visibility state.
 *
 * Drives the HUD's "Model status" row + the persona-switch toast. The
 * directive (2026-05-24) requires explicit user-visible states for:
 *   - Loading <persona>…   (modelStatus="loading", with modelStatusPersona)
 *   - Model ready          (modelStatus="ready", auto-clear after ~1.5s)
 *   - Model failed         (modelStatus="failed", with message)
 *   - Model not configured (modelStatus="not_configured")
 *
 * `idle` is the steady state once a swap has resolved.
 */
export type ModelStatus =
  | "idle"
  | "loading"
  | "ready"
  | "failed"
  | "not_configured";
const LATENCY_WINDOW = 10;

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

interface ArgosState {
  currentPersonaId: PersonaId;
  currentModel: string;
  currentTab: Tab;
  messages: ChatMessage[];
  isStreaming: boolean;
  hudMetrics: HudMetrics;
  vaultStatus: VaultStatus;
  activeCitation: CitedHit | null;
  truthMode: boolean;
  /** The persisted-session id this chat belongs to, or null if not
   *  yet saved. Set on first auto-save after assistant completes. */
  currentSessionId: string | null;
  /** Phase 2-RB: visible model load/swap status for the HUD + toasts. */
  modelStatus: ModelStatus;
  modelStatusPersona: PersonaId | null;
  modelStatusMessage: string | null;

  switchPersona: (id: PersonaId) => Promise<void>;
  setModel: (m: string) => void;
  setTab: (t: Tab) => void;
  appendMessage: (m: ChatMessage) => void;
  appendToLastMessage: (chunk: string) => void;
  patchLastMessage: (patch: Partial<ChatMessage>) => void;
  setStreaming: (b: boolean) => void;
  setHudMetric: <K extends keyof HudMetrics>(key: K, value: HudMetrics[K]) => void;
  pushLatency: (ms: number) => void;
  resetHudMetrics: () => void;
  clearChat: () => void;
  setVaultCounts: (docs: number, chunks: number) => void;
  setVaultIngesting: (filename: string | null) => void;
  setActiveCitation: (hit: CitedHit | null) => void;
  setTruthMode: (b: boolean) => void;
  setCurrentSessionId: (id: string | null) => void;
  /** Replace the entire in-memory chat with a loaded persisted session. */
  loadSession: (id: string, messages: ChatMessage[], personaId: PersonaId, model: string) => void;

  eyeColor: () => string;
  accentColor: () => string;
  personaName: () => string;
}

export const useArgos = create<ArgosState>((set, get) => ({
  // Phase 2-RB default: Bart is the primary persona at first launch
  // (owner directive 2026-05-24). e4b:latest validated on this rig;
  // see PHASE_2_MODEL_VALIDATION.md.
  currentPersonaId: "bartimaeus",
  currentModel: DEFAULT_MODEL,
  currentTab: "chat",
  messages: [],
  isStreaming: false,
  hudMetrics: { ...EMPTY_METRICS },
  vaultStatus: { ...EMPTY_VAULT },
  activeCitation: null,
  truthMode: false,
  modelStatus: "idle",
  modelStatusPersona: null,
  modelStatusMessage: null,

  // Phase 2-RB: persona-bound model with visible swap state. Steps:
  //   1. If persona is not_configured, set modelStatus=not_configured
  //      and bail without touching currentModel (no fake binding).
  //   2. Else, set modelStatus="loading" + rebind currentPersonaId +
  //      currentModel synchronously (so UI re-renders immediately).
  //   3. Fire /api/model/warm in the background. On 200 → "ready"
  //      (auto-clear after 1500ms). On failure → "failed".
  switchPersona: async (id) => {
    const p = PERSONA_BY_ID[id];
    const fromPersonaId = get().currentPersonaId;
    if (!isPersonaSelectable(p)) {
      set({
        modelStatus: "not_configured",
        modelStatusPersona: id,
        modelStatusMessage: p.intendedModel
          ? `${p.name}: model "${p.intendedModel}" not in local Ollama store. Install + re-bind in lib/personas.ts.`
          : `${p.name} has no configured model.`,
      });
      // v1.1: still log the *attempted* switch even when not_configured.
      // Operator behavior tracking — useful for understanding which
      // unconfigured personas operators actually want.
      void fetch("/api/persona/switched", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          personaId: id,
          fromPersonaId,
          model: p.model || null,
          reason: "user-attempt-not-configured",
          sessionId: get().currentSessionId,
        }),
      }).catch(() => undefined);
      return;
    }
    set({
      currentPersonaId: id,
      currentModel: p.model,
      modelStatus: "loading",
      modelStatusPersona: id,
      modelStatusMessage: `Loading ${p.name}…`,
    });
    // v1.1: best-effort persona.switched audit append. Fire AFTER
    // the UI flip + BEFORE the warm POST so the audit reflects intent
    // even if warm fails. Failures are silent — never blocks UI.
    void fetch("/api/persona/switched", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personaId: id,
        fromPersonaId,
        model: p.model,
        reason: "user-switch",
        sessionId: get().currentSessionId,
      }),
    }).catch(() => undefined);
    // Background warm — never blocks the UI. /api/model/warm POSTs an
    // empty prompt to Ollama which forces a model load (or no-op if
    // already loaded) and replies when ready.
    try {
      const r = await fetch("/api/model/warm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: p.model }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        set({
          modelStatus: "failed",
          modelStatusPersona: id,
          modelStatusMessage: body.error
            ? `${p.name}: ${body.error}`
            : `${p.name}: HTTP ${r.status}`,
        });
        return;
      }
      set({
        modelStatus: "ready",
        modelStatusPersona: id,
        modelStatusMessage: "Model ready",
      });
      // Auto-clear after 1.5s back to idle.
      setTimeout(() => {
        // Only clear if still on this persona and still "ready".
        const cur = get();
        if (cur.modelStatus === "ready" && cur.modelStatusPersona === id) {
          set({
            modelStatus: "idle",
            modelStatusPersona: null,
            modelStatusMessage: null,
          });
        }
      }, 1500);
    } catch (e) {
      set({
        modelStatus: "failed",
        modelStatusPersona: id,
        modelStatusMessage: `${p.name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  },
  setModel: (m) => set({ currentModel: m }),
  setTab: (t) => set({ currentTab: t }),

  appendMessage: (m) =>
    set((s) => ({ messages: [...s.messages, m] })),

  appendToLastMessage: (chunk) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      const updated: ChatMessage = { ...last, content: last.content + chunk };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

  patchLastMessage: (patch) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      const updated: ChatMessage = { ...last, ...patch };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),

  setStreaming: (b) => set({ isStreaming: b }),

  setHudMetric: (key, value) =>
    set((s) => ({ hudMetrics: { ...s.hudMetrics, [key]: value } })),

  pushLatency: (ms) =>
    set((s) => {
      const next = [...s.hudMetrics.recentLatencies, ms].slice(-LATENCY_WINDOW);
      return {
        hudMetrics: {
          ...s.hudMetrics,
          recentLatencies: next,
          p50LatencyMs: p50(next),
          latencyMs: ms,
        },
      };
    }),

  resetHudMetrics: () => set({ hudMetrics: { ...EMPTY_METRICS } }),
  clearChat: () =>
    set({
      messages: [],
      hudMetrics: { ...EMPTY_METRICS },
      isStreaming: false,
      // Clearing the chat ALSO drops the session linkage — next send
      // creates a fresh session rather than over-writing the cleared one.
      currentSessionId: null,
    }),

  setVaultCounts: (docs, chunks) =>
    set((s) => ({ vaultStatus: { ...s.vaultStatus, docs, chunks } })),
  setVaultIngesting: (filename) =>
    set((s) => ({ vaultStatus: { ...s.vaultStatus, ingesting: filename } })),
  setActiveCitation: (hit) => set({ activeCitation: hit }),
  setTruthMode: (b) => set({ truthMode: b }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  loadSession: (id, messages, personaId, model) =>
    set({
      currentSessionId: id,
      messages,
      currentPersonaId: personaId,
      currentModel: model,
      hudMetrics: { ...EMPTY_METRICS },
      isStreaming: false,
    }),

  currentSessionId: null,

  eyeColor: () => PERSONA_BY_ID[get().currentPersonaId].eyeColor,
  accentColor: () => PERSONA_BY_ID[get().currentPersonaId].accentColor,
  personaName: () => PERSONA_BY_ID[get().currentPersonaId].name,
}));
