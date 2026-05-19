import { promises as fsp } from "node:fs";
import path from "node:path";
import { argosRoot } from "@/lib/vault/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedPkg: { name: string; version: string } | null = null;

async function readPackage(): Promise<{ name: string; version: string }> {
  if (cachedPkg) return cachedPkg;
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const raw = await fsp.readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    cachedPkg = {
      name: parsed.name ?? "argos-claude",
      version: parsed.version ?? "0.0.0",
    };
    return cachedPkg;
  } catch {
    return { name: "argos-claude", version: "0.0.0" };
  }
}

const startedAt = Date.now();

export async function GET() {
  const pkg = await readPackage();
  return Response.json({
    appName: pkg.name,
    version: pkg.version,
    argosRoot: argosRoot(),
    isDev: !process.env.ARGOS_ROOT,
    ollamaUrl: "http://127.0.0.1:11434",
    startedAt,
  });
}
