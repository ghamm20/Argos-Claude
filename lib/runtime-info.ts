import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "./vault/paths";
import { getOllamaBase } from "./ollama-config";

export interface RuntimeInfo {
  appName: string;
  version: string;
  argosRoot: string;
  isDev: boolean;
  ollamaUrl: string;
  startedAt: number;
}

const STARTED_AT = Date.now();
let pkgCache: { name: string; version: string } | null = null;

async function readPackage(): Promise<{ name: string; version: string }> {
  if (pkgCache) return pkgCache;
  try {
    const raw = await fsp.readFile(
      path.join(process.cwd(), "package.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    pkgCache = {
      name: parsed.name ?? "argos-claude",
      version: parsed.version ?? "0.0.0",
    };
  } catch {
    pkgCache = { name: "argos-claude", version: "0.0.0" };
  }
  return pkgCache;
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const pkg = await readPackage();
  return {
    appName: pkg.name,
    version: pkg.version,
    argosRoot: argosRoot(),
    isDev: !process.env.ARGOS_ROOT,
    ollamaUrl: getOllamaBase(),
    startedAt: STARTED_AT,
  };
}
