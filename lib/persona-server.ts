// lib/persona-server.ts
//
// v1.1 — server-only persona resolution with config overrides applied.
//
// Why this is a SEPARATE module from lib/personas.ts: persona-overrides
// reads from node:fs, which webpack refuses to bundle for the client.
// lib/personas.ts is imported by both client (store + UI) and server
// (API routes). Keeping the override-aware resolver here means client
// imports of personas.ts never touch the fs-dependent code path.
//
// API routes that care about EFFECTIVE wiring (chat, model warm,
// persona switched) import from this file. Client code keeps using
// PERSONA_BY_ID from lib/personas.ts.

import {
  PERSONA_BY_ID,
  type Persona,
  type PersonaId,
} from "./personas";
import { getPersonaOverridesMap } from "./persona-overrides";

/**
 * Resolve a persona with config-overrides applied. Static
 * `PERSONA_BY_ID` is the identity source; this function reads
 * `$ARGOS_ROOT/config/persona-overrides.json` (cached) and merges
 * `model`, `status`, `intendedModel` over the static values.
 *
 * Identity invariants (name, eyeColor, accentColor, systemPrompt,
 * retrieval policy) are NEVER overridden — those are authoring
 * decisions, not config.
 */
export async function resolvePersona(id: PersonaId): Promise<Persona> {
  const base = PERSONA_BY_ID[id];
  const overrides = await getPersonaOverridesMap();
  const o = overrides[id];
  if (!o) return base;
  return {
    ...base,
    model: o.model ?? base.model,
    status: o.status ?? base.status,
    intendedModel: o.intendedModel ?? base.intendedModel,
  };
}

/** Resolve all personas with overrides applied. */
export async function resolveAllPersonas(): Promise<Record<PersonaId, Persona>> {
  const ids: PersonaId[] = ["bartimaeus", "juniper", "sage", "bobby"];
  const out = {} as Record<PersonaId, Persona>;
  for (const id of ids) out[id] = await resolvePersona(id);
  return out;
}
