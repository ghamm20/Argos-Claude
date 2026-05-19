import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import type { PersonaId } from "./personas";

export const SETTINGS_VERSION = 1;

export interface PersistedSettings {
  version: number;
  defaultPersona: PersonaId;
  defaultModel: string;
  updatedAt: number;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  version: SETTINGS_VERSION,
  defaultPersona: "bartimaeus",
  defaultModel: "llama3.1:8b-instruct-q4_K_M",
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
  await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
