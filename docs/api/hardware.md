# GET /api/hardware

Returns the detected hardware profile and a recommended model. Detection runs every request — no caching, no host writes.

## Request

```http
GET /api/hardware
```

No body, no headers, no query string.

## Response

### Success: `200 OK`

```json
{
  "totalRamGB": 64,
  "cpuModel": "11th Gen Intel(R) Core(TM) i7-11700F @ 2.50GHz",
  "cpuCores": 16,
  "platform": "win32",
  "mode": "gpu",
  "gpuName": "NVIDIA GeForce RTX 3060 Ti",
  "gpuVramGB": 8,
  "recommendedModel": "llama3.1:8b-instruct-q4_K_M",
  "recommendedContextSize": 4096,
  "reason": "NVIDIA GeForce RTX 3060 Ti (8 GB VRAM) detected — running 8B at full quality",
  "detectedAt": 1779323091545
}
```

### Fields

| Field | Type | Always present | Notes |
|---|---|---|---|
| `totalRamGB` | `number` | yes | Total system RAM, integer GB |
| `cpuModel` | `string` | yes | From `os.cpus()[0].model` |
| `cpuCores` | `number` | yes | Logical core count |
| `platform` | `"win32" \| "darwin" \| "linux"` | yes | `process.platform` |
| `mode` | `"gpu" \| "metal" \| "cpu"` | yes | Inference fallback path |
| `gpuName` | `string` | when `mode === "gpu" \| "metal"` | Detected via nvidia-smi (Windows/Linux) or system_profiler (macOS) |
| `gpuVramGB` | `number` | when `mode === "gpu" \| "metal"` | GPU VRAM, integer GB |
| `recommendedModel` | `string` | yes | One of `AVAILABLE_MODELS`, picked by capability |
| `recommendedContextSize` | `number` | yes | Ollama `num_ctx`; 4096 default |
| `reason` | `string` | yes | Human-readable explanation of the recommendation |
| `detectedAt` | `number` | yes | Unix epoch ms when detection ran |

### Detection cascade (`lib/hardware.ts`)

1. `mode = "gpu"` if `nvidia-smi` returns a CUDA-capable card (Windows/Linux)
2. `mode = "metal"` if macOS Apple Silicon detected via `system_profiler SPHardwareDataType`
3. `mode = "cpu"` otherwise

VRAM is read from `nvidia-smi --query-gpu=memory.total` or the macOS equivalent. CPU info falls back to `os.cpus()` if platform-specific calls fail.

### Recommended-model logic

- `mode === "gpu"` and `gpuVramGB >= 8` → `llama3.1:8b-instruct-q4_K_M`
- `mode === "metal"` and Apple Silicon → `llama3.1:8b-instruct-q4_K_M`
- `mode === "cpu"` and `totalRamGB >= 16` → `qwen2.5:3b-instruct-q4_K_M`
- Otherwise → `qwen2.5:3b-instruct-q4_K_M` (fast path)

### Errors

| Status | Body | Cause |
|---|---|---|
| `500` | `{ error: "hardware detection failed", detail: "..." }` | Detection threw unexpectedly |

## Caching

None. Every request runs the full detection cascade. On a modern dev box this is ~50-200 ms total (dominated by the `nvidia-smi` subprocess call). The client may choose to cache, but the API itself is stateless.
