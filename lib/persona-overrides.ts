// lib/persona-overrides.ts
//
// v1.1 — Power Mode / future-hardware config override layer.
//
// Read at server boot (lazy, cached). If
// $ARGOS_ROOT/config/persona-overrides.json exists, its entries
// override `model`, `status`, and `intendedModel` for matching
// persona IDs. Everything else (system prompt, eye color, retrieval
// policy, name) comes from lib/personas.ts unchanged — those are
// the persona-identity invariants.
//
// Use case: same source code targets multiple rigs (8 GB dev,
// 24 GB 4090, 32 GB 5090) without code edits. Operator drops the
// JSON, restarts, the personas come up bound to their hardware-
// appropriate models.
//
// File format (all fields optional per-persona):
//
//   {
//     "comment": "optional human note; ignored",
//     "overrides": {
//       "bartimaeus": { "model": "huihui_ai/gpt-oss-abliterated:20b", "status": "live" },
//       "juniper":    { "model": "hf.co/HauhauCS/Qwen3.5-9B-...:Q4_K_M", "status": "selectable" }
//     },
//     "availableModelsAdditions": [
//       "huihui_ai/gpt-oss-abliterated:20b",
//       "hf.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive:Q4_K_M"
//     ]
//   }
//
// Doctrine: this is a CONFIG layer, not a CODE layer. The
// persona-identity decision (who Bart IS) lives in lib/personas.ts
// because it's a deliberate authoring choice. The hardware-binding
// decision (which model serves Bart on THIS rig) is operator
// configuration.
//
// Audit: any boot with an active override emits a `settings.changed`
// audit entry tagged with `personaOverridesApplied: true` and the
// list of overridden persona IDs.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import type { PersonaId, PersonaStatus } from "./personas";

export interface PersonaOverride {
  model?: string;
  status?: PersonaStatus;
  intendedModel?: string;
}

export interface PersonaOverridesFile {
  comment?: string;
  overrides?: Partial<Record<PersonaId, PersonaOverride>>;
  /** Extra models to append to AVAILABLE_MODELS at runtime. */
  availableModelsAdditions?: string[];
}

export function personaOverridesPath(): string {
  return path.join(argosRoot(), "config", "persona-overrides.json");
}

let _cached: PersonaOverridesFile | null | undefined = undefined;

/** Read the overrides file. Returns null if file missing or invalid.
 *  Cached per process lifetime; call resetPersonaOverridesCache() to
 *  re-read after operator edits. */
export async function readPersonaOverrides(): Promise<PersonaOverridesFile | null> {
  if (_cached !== undefined) return _cached;
  try {
    const raw = await fsp.readFile(personaOverridesPath(), "utf8");
    const parsed = JSON.parse(raw) as PersonaOverridesFile;
    // Light validation — anything malformed becomes null + a warn.
    if (typeof parsed !== "object" || parsed === null) {
      console.warn(`[persona-overrides] file is not an object; ignoring`);
      _cached = null;
      return null;
    }
    if (parsed.overrides && typeof parsed.overrides !== "object") {
      console.warn(`[persona-overrides] 'overrides' must be an object; ignoring`);
      _cached = null;
      return null;
    }
    _cached = parsed;
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      _cached = null;
      return null;
    }
    console.warn(
      `[persona-overrides] failed to read ${personaOverridesPath()}: ${
        (e as Error).message
      } — using lib/personas.ts as-is`
    );
    _cached = null;
    return null;
  }
}

/** Test-only: drop the in-process cache. */
export function _resetPersonaOverridesCache(): void {
  _cached = undefined;
}

/** Convenience accessor: returns the overrides map keyed by personaId,
 *  or an empty object if no overrides file is present. */
export async function getPersonaOverridesMap(): Promise<
  Partial<Record<PersonaId, PersonaOverride>>
> {
  const file = await readPersonaOverrides();
  return file?.overrides ?? {};
}

/** Convenience accessor: extra models to add to AVAILABLE_MODELS. */
export async function getAvailableModelsAdditions(): Promise<readonly string[]> {
  const file = await readPersonaOverrides();
  return Object.freeze(file?.availableModelsAdditions ?? []);
}
