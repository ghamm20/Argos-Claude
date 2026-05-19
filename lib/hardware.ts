import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "none";
export type RuntimeMode = "gpu" | "metal" | "cpu";

export interface HardwareProfile {
  gpuVendor: GpuVendor;
  gpuName: string | null;
  vramGB: number;
  totalRamGB: number;
  cpuModel: string;
  cpuCores: number;
  platform: NodeJS.Platform;
  mode: RuntimeMode;
  recommendedModel: string;
  recommendedContextSize: number;
  reason: string;
  detectedAt: number;
}

const MODEL_LARGE = "llama3.1:8b-instruct-q4_K_M";
const MODEL_SMALL = "qwen2.5:3b-instruct-q4_K_M";

let cached: HardwareProfile | null = null;

interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  vramBytes: number;
}

function classifyVendor(name: string): GpuVendor {
  const lower = name.toLowerCase();
  if (lower.includes("nvidia") || lower.includes("geforce") || lower.includes("rtx") || lower.includes("gtx") || lower.includes("quadro"))
    return "nvidia";
  if (lower.includes("amd") || lower.includes("radeon") || lower.includes("ati ")) return "amd";
  if (lower.includes("intel") && (lower.includes("graphics") || lower.includes("uhd") || lower.includes("iris")))
    return "intel";
  if (lower.includes("apple")) return "apple";
  return "none";
}

async function tryNvidiaSmi(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      { timeout: 4000 }
    );
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!first) return null;
    const [name, memMB] = first.split(",").map((s) => s.trim());
    if (!name) return null;
    const vramBytes = (parseInt(memMB, 10) || 0) * 1024 * 1024;
    return { vendor: "nvidia", name, vramBytes };
  } catch {
    return null;
  }
}

async function tryWmic(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execAsync(
      "wmic path win32_VideoController get Name,AdapterRAM /format:list",
      { timeout: 5000, windowsHide: true }
    );
    const blocks = stdout.split(/\r?\n\r?\n/);
    const gpus: GpuInfo[] = [];
    for (const block of blocks) {
      const nameMatch = /Name=(.+)/i.exec(block);
      const ramMatch = /AdapterRAM=(\d+)/i.exec(block);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        if (!name) continue;
        const vramBytes = ramMatch ? parseInt(ramMatch[1], 10) || 0 : 0;
        gpus.push({ vendor: classifyVendor(name), name, vramBytes });
      }
    }
    if (gpus.length === 0) return null;
    // Pick the one with the most VRAM (discrete > integrated usually).
    return gpus.reduce((a, b) => (a.vramBytes > b.vramBytes ? a : b));
  } catch {
    return null;
  }
}

async function tryPowerShellCim(): Promise<GpuInfo | null> {
  try {
    const cmd =
      "powershell -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress\"";
    const { stdout } = await execAsync(cmd, { timeout: 7000, windowsHide: true });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as
      | { Name?: string; AdapterRAM?: number }[]
      | { Name?: string; AdapterRAM?: number };
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const gpus: GpuInfo[] = [];
    for (const e of arr) {
      const name = (e.Name ?? "").trim();
      if (!name) continue;
      const vramBytes = typeof e.AdapterRAM === "number" ? e.AdapterRAM : 0;
      gpus.push({ vendor: classifyVendor(name), name, vramBytes });
    }
    if (gpus.length === 0) return null;
    return gpus.reduce((a, b) => (a.vramBytes > b.vramBytes ? a : b));
  } catch {
    return null;
  }
}

async function tryLinuxLspci(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execAsync("lspci | grep -iE 'vga|3d|display'", {
      timeout: 4000,
    });
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!first) return null;
    const name = first.replace(/^[^:]+:\s*/, "").trim();
    return { vendor: classifyVendor(name), name, vramBytes: 0 };
  } catch {
    return null;
  }
}

function isAppleSilicon(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const cpus = os.cpus();
    if (cpus.length === 0) return false;
    return /apple|m[1-9]/i.test(cpus[0].model);
  } catch {
    return false;
  }
}

async function detectGpu(): Promise<GpuInfo | null> {
  if (isAppleSilicon()) {
    const cpuModel = os.cpus()[0]?.model ?? "Apple Silicon";
    return { vendor: "apple", name: cpuModel, vramBytes: 0 };
  }
  // NVIDIA-first across platforms.
  const nv = await tryNvidiaSmi();
  if (nv) return nv;
  if (process.platform === "win32") {
    const w = await tryWmic();
    if (w) return w;
    const ps = await tryPowerShellCim();
    if (ps) return ps;
  } else if (process.platform === "linux") {
    const l = await tryLinuxLspci();
    if (l) return l;
  }
  return null;
}

function decide(profile: {
  vendor: GpuVendor;
  gpuName: string | null;
  vramGB: number;
  totalRamGB: number;
}): { mode: RuntimeMode; model: string; ctx: number; reason: string } {
  const { vendor, gpuName, vramGB, totalRamGB } = profile;

  if (vendor === "nvidia" && vramGB >= 6) {
    return {
      mode: "gpu",
      model: MODEL_LARGE,
      ctx: 4096,
      reason: `${gpuName ?? "NVIDIA GPU"} (${vramGB.toFixed(0)} GB VRAM) detected — running 8B at full quality`,
    };
  }
  if (vendor === "nvidia" && vramGB > 0 && vramGB < 6) {
    return {
      mode: "gpu",
      model: MODEL_SMALL,
      ctx: 2048,
      reason: `${gpuName ?? "NVIDIA GPU"} has ${vramGB.toFixed(0)} GB VRAM — under 6 GB threshold, falling back to compact 3B model`,
    };
  }
  if (vendor === "apple" && totalRamGB >= 16) {
    return {
      mode: "metal",
      model: MODEL_LARGE,
      ctx: 4096,
      reason: `${gpuName ?? "Apple Silicon"} detected with ${totalRamGB} GB unified memory — Metal acceleration, 8B model`,
    };
  }
  if (vendor === "apple") {
    return {
      mode: "metal",
      model: MODEL_SMALL,
      ctx: 2048,
      reason: `${gpuName ?? "Apple Silicon"} with ${totalRamGB} GB unified memory — under 16 GB, using compact 3B model`,
    };
  }
  if (vendor === "amd") {
    return {
      mode: "cpu",
      model: MODEL_SMALL,
      ctx: 2048,
      reason: `CPU mode — ${gpuName ?? "AMD GPU"} not accelerated by Ollama on this platform — using compact 3B model`,
    };
  }
  if (vendor === "intel") {
    return {
      mode: "cpu",
      model: MODEL_SMALL,
      ctx: 2048,
      reason: `CPU mode — ${gpuName ?? "Intel integrated graphics"} not accelerated by Ollama — using compact 3B model`,
    };
  }
  return {
    mode: "cpu",
    model: MODEL_SMALL,
    ctx: 2048,
    reason: "CPU mode — no compatible GPU detected — using compact 3B model",
  };
}

export async function detectHardware(force = false): Promise<HardwareProfile> {
  if (cached && !force) return cached;

  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "unknown CPU";
  const cpuCores = cpus.length;
  const totalRamGB = Math.round(os.totalmem() / 1024 ** 3);

  const gpu = await detectGpu();
  const vendor: GpuVendor = gpu?.vendor ?? "none";
  const gpuName = gpu?.name ?? null;
  const vramGB =
    gpu && gpu.vramBytes > 0 ? Math.round(gpu.vramBytes / 1024 ** 3) : 0;

  const decision = decide({ vendor, gpuName, vramGB, totalRamGB });

  cached = {
    gpuVendor: vendor,
    gpuName,
    vramGB,
    totalRamGB,
    cpuModel,
    cpuCores,
    platform: process.platform,
    mode: decision.mode,
    recommendedModel: decision.model,
    recommendedContextSize: decision.ctx,
    reason: decision.reason,
    detectedAt: Date.now(),
  };
  return cached;
}

export function clearHardwareCache(): void {
  cached = null;
}
