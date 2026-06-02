import { argosRoot } from "./vault/paths";
import { getOllamaBase } from "./ollama-config";
// Build-time version (2026-06-02 HUD fix). Importing package.json INLINES the
// name + version into the compiled server bundle at BUILD time (webpack /
// Next, resolveJsonModule). The reported version then travels INSIDE `.next`
// (which we mirror to the USB payload) and is INDEPENDENT of the runtime cwd.
//
// Why this matters: getRuntimeInfo used to read package.json from
// process.cwd() at runtime and cache it for the process lifetime. The HUD
// could show a stale version (the v0.1.0 bug) because:
//   - the running server process pinned the value read at first request, and
//   - the deployed D:\ARGOS\app\package.json is not part of the `.next`
//     mirror, so a cwd read could lag the source bump.
// Baking the version at build removes both failure modes — the value is fixed
// when `npm run build` runs in the dev repo (single source of truth) and ships
// with the build artifact.
import pkg from "../package.json";

export interface RuntimeInfo {
  appName: string;
  version: string;
  argosRoot: string;
  isDev: boolean;
  ollamaUrl: string;
  startedAt: number;
}

const STARTED_AT = Date.now();
const BUILD_NAME = (pkg as { name?: string }).name ?? "argos-claude";
const BUILD_VERSION = (pkg as { version?: string }).version ?? "0.0.0";

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return {
    appName: BUILD_NAME,
    version: BUILD_VERSION,
    argosRoot: argosRoot(),
    isDev: !process.env.ARGOS_ROOT,
    ollamaUrl: getOllamaBase(),
    startedAt: STARTED_AT,
  };
}
