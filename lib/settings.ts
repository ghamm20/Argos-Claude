import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import type { PersonaId } from "./personas";
import { appendAudit } from "./audit";

export const SETTINGS_VERSION = 1;

export interface PersistedSettings {
  version: number;
  defaultPersona: PersonaId;
  defaultModel: string;
  updatedAt: number;
}

// Phase 2-RB defaults — Bart on e4b:latest is the only "live" persona
// at boot on this hardware. See PHASE_2_MODEL_VALIDATION.md for the
// measurement evidence. Operator-overridable via the Settings UI;
// writes to ARGOS_ROOT/config/settings.json (atomic temp+rename).
const DEFAULT_SETTINGS: PersistedSettings = {
  version: SETTINGS_VERSION,
  defaultPersona: "bartimaeus",
  defaultModel: "e4b:latest",
  updatedAt: 0,
};

export function configDir(): string {
  return path.join(argosRoot(), "config");
}

export function settingsPath(): string {
  return path.join(configDir(), "settings.json");
}

export async function readSettings(): Promise<PersistedSettings> {
  try {
    const raw = await fsp.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      version: SETTINGS_VERSION,
      defaultPersona: parsed.defaultPersona ?? DEFAULT_SETTINGS.defaultPersona,
      defaultModel: parsed.defaultModel ?? DEFAULT_SETTINGS.defaultModel,
      updatedAt: parsed.updatedAt ?? DEFAULT_SETTINGS.updatedAt,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_SETTINGS };
    }
    throw e;
  }
}

export async function writeSettings(
  patch: Partial<Omit<PersistedSettings, "version" | "updatedAt">>
): Promise<PersistedSettings> {
  const current = await readSettings();
  const next: PersistedSettings = {
    ...current,
    ...patch,
    version: SETTINGS_VERSION,
    updatedAt: Date.now(),
  };
  await fsp.mkdir(configDir(), { recursive: true });
  // Atomic write: write to a per-pid temp file in the same dir, fsync,
  // then rename over the target. If the process is killed (or the USB
  // is yanked) mid-write, the worst case is an orphaned .tmp file —
  // settings.json itself is either the previous valid version or the
  // new one, never partial.
  //
  // Filed as Gap A in methodology/threat-model-audit.md after the H8.5
  // audit. Same place needed protection during the H8.5 NTFS-corruption-
  // from-yank-during-write incident; this brings settings up to the
  // same posture.
  const finalPath = settingsPath();
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const payload = JSON.stringify(next, null, 2);
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    // fsync forces the write to disk before we rename, so the rename
    // can't make a stale-content file visible to readers.
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, finalPath);

  // Phase 4 audit: record settings change. Best-effort — audit append
  // failure does NOT roll back the settings write (settings is the
  // authoritative store; audit is the receipt).
  try {
    await appendAudit("settings.changed", {
      changed: Object.keys(patch),
      defaultPersona: next.defaultPersona,
      defaultModel: next.defaultModel,
    });
  } catch (auditErr) {
    console.warn(
      `[settings] audit append failed (non-fatal): ${
        (auditErr as Error).message
      }`
    );
  }

  return next;
}
