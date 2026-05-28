// components/auth/PinGate.tsx
//
// Operator Auth (2026-05-28) — full-screen PIN entry overlay.
//
// Mounted via AuthClientWrapper in the root layout so it sees every
// page. On mount, fetches /api/settings to learn whether auth is even
// enabled (requirePin). If disabled, renders nothing — auth is opt-in.
// If enabled AND no valid sessionStorage token exists, renders an
// opaque overlay that blocks the entire UI until a correct PIN is
// entered.
//
// Visibility model:
//   requirePin:false              → never overlay (children always shown)
//   requirePin:true, token valid  → never overlay
//   requirePin:true, no token     → opaque overlay over children
//   requirePin:true, wrong PIN    → "ACCESS DENIED" flash, refocus
//
// The wrong-PIN flash is purely cosmetic; the server enforces the gate.
// (A determined attacker who DevTools'd through the overlay would still
// get guest-mode responses from /api/chat — no operator memory, no
// project context. The overlay is UX, not the security boundary.)

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Lock, Loader2 } from "lucide-react";
import {
  hashPinClient,
  setSessionToken,
  getSessionToken,
  clearSessionToken,
} from "@/lib/auth-client";

interface SettingsLite {
  requirePin?: boolean;
}

type GateState =
  | { kind: "loading" }
  | { kind: "disabled" } // requirePin === false → render children directly
  | { kind: "authenticated" } // valid token present
  | { kind: "locked" } // requirePin && no token → show overlay
  | { kind: "verifying" }
  | { kind: "denied" };

export function PinGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // On mount: fetch settings, decide whether to gate, and (when gated)
  // honour any pre-existing sessionStorage token from this tab session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as SettingsLite;
        if (cancelled) return;
        if (j.requirePin !== true) {
          setState({ kind: "disabled" });
          return;
        }
        // Auth required — check for a token from a previous step in
        // this same tab session. (Tab close clears sessionStorage so
        // a cold start always re-prompts.)
        const tok = getSessionToken();
        if (tok && tok.length > 0) {
          setState({ kind: "authenticated" });
          return;
        }
        setState({ kind: "locked" });
      } catch {
        // Settings fetch failed — default to NOT gating. Better to
        // serve the UI in guest mode than to lock the operator out of
        // their own machine over a transient fetch error.
        if (!cancelled) setState({ kind: "disabled" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-mount focus when entering the locked state.
  useEffect(() => {
    if (state.kind === "locked" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [state.kind]);

  const submit = useCallback(async () => {
    const trimmed = pin.trim();
    if (trimmed.length < 4 || trimmed.length > 8) {
      // Don't ping the server with an obviously-invalid candidate.
      setState({ kind: "denied" });
      window.setTimeout(() => {
        setPin("");
        setState({ kind: "locked" });
      }, 1500);
      return;
    }
    setState({ kind: "verifying" });
    try {
      const pinHash = await hashPinClient(trimmed);
      const r = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinHash }),
      });
      if (r.ok) {
        const j = (await r.json()) as { token?: string };
        if (j.token) {
          setSessionToken(j.token);
          setPin("");
          setState({ kind: "authenticated" });
          return;
        }
      }
      // Any non-ok (401 most likely) → wrong PIN.
      setState({ kind: "denied" });
      window.setTimeout(() => {
        setPin("");
        setState({ kind: "locked" });
      }, 2000);
    } catch {
      // Network error / subtle.crypto unavailable. Same denied UX —
      // operator retries.
      setState({ kind: "denied" });
      window.setTimeout(() => {
        setPin("");
        setState({ kind: "locked" });
      }, 2000);
    }
  }, [pin]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  // States where children render normally underneath nothing.
  if (state.kind === "loading") {
    // Brief flash; render children dimmed so the page doesn't fully
    // blank during the settings probe. Better than a hard wipe.
    return <>{children}</>;
  }
  if (state.kind === "disabled" || state.kind === "authenticated") {
    return <>{children}</>;
  }

  // Locked / verifying / denied → full-screen opaque overlay over
  // whatever children rendered (children are still in the DOM behind
  // it; the overlay's z-index + opaque background hide them).
  return (
    <>
      {children}
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        style={{ background: "rgba(10, 10, 10, 0.98)" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-gate-title"
      >
        <div className="w-full max-w-sm px-8">
          {/* ARGOS eye — same green as Bart's accent so the brand cue
              carries even before any persona renders. */}
          <div className="flex justify-center mb-6">
            <Eye
              size={64}
              strokeWidth={1.25}
              style={{ color: "#10b981" }}
            />
          </div>
          <div
            id="pin-gate-title"
            className="text-center text-[11px] uppercase tracking-[0.32em] mb-6"
            style={{ color: "#00ff9d" }}
          >
            Operator Authentication
          </div>
          <div className="flex items-center gap-2 mb-3">
            <Lock size={14} className="text-neutral-500" />
            <span className="text-[12px] uppercase tracking-[0.18em] text-neutral-400">
              PIN
            </span>
          </div>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={state.kind === "verifying"}
            placeholder="••••"
            className="w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-2 text-[18px] font-mono text-center tracking-[0.4em] text-neutral-100 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            style={
              state.kind === "denied"
                ? { borderColor: "#ef4444", color: "#ef4444" }
                : undefined
            }
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={state.kind === "verifying" || pin.length < 4}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[12px] font-medium uppercase tracking-[0.18em] text-neutral-950 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background:
                state.kind === "denied" ? "rgba(239, 68, 68, 0.85)" : "#00ff9d",
            }}
          >
            {state.kind === "verifying" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : state.kind === "denied" ? (
              "Access Denied"
            ) : (
              "Authenticate"
            )}
          </button>
          <p className="mt-6 text-[10px] text-neutral-600 leading-relaxed text-center">
            Forgot your PIN? Edit{" "}
            <span className="font-mono text-neutral-500">
              config/settings.json
            </span>{" "}
            and set <span className="font-mono text-neutral-500">operatorPinHash</span>{" "}
            to <span className="font-mono text-neutral-500">null</span>.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * Helper for the HUD's "Lock session" affordance. Clears the
 * sessionStorage token AND forces a hard reload so the PinGate's
 * mount-time check runs fresh and the overlay re-appears.
 */
export function lockOperatorSession(): void {
  clearSessionToken();
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
