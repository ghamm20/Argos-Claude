# copy-model-to-d.ps1 — copy an Ollama model (manifest + content-addressed
# blobs) from the default store into the D: launcher store so the deployed
# ARGOS payload (OLLAMA_MODELS=D:\ARGOS\models) can load it. Safe to run while
# Ollama is up — blobs are immutable.
param(
  [string]$Model = "aratan/gemma-4-E4B-q8-it-heretic",
  [string]$Tag = "latest"
)
$src = Join-Path $env:USERPROFILE ".ollama\models"
$dst = "D:\ARGOS\models"
$manRel = "manifests\registry.ollama.ai\$($Model -replace '/', '\')\$Tag"
$srcMan = Join-Path $src $manRel
$dstMan = Join-Path $dst $manRel
if (-not (Test-Path $srcMan)) { Write-Error "source manifest not found: $srcMan"; exit 1 }

$man = Get-Content $srcMan -Raw | ConvertFrom-Json
$digests = @($man.config.digest) + ($man.layers | ForEach-Object { $_.digest })
$copied = 0; $skipped = 0
foreach ($d in $digests) {
  $blobName = "sha256-" + ($d -replace '^sha256:', '')
  $sb = Join-Path $src "blobs\$blobName"
  $db = Join-Path $dst "blobs\$blobName"
  if (Test-Path $db) { $skipped++; continue }
  if (-not (Test-Path $sb)) { Write-Error "missing blob: $sb"; exit 1 }
  New-Item -ItemType Directory -Force -Path (Split-Path $db) | Out-Null
  Copy-Item $sb $db -Force
  $copied++
}
New-Item -ItemType Directory -Force -Path (Split-Path $dstMan) | Out-Null
Copy-Item $srcMan $dstMan -Force
"copied $copied blob(s), skipped $skipped already-present; manifest -> $dstMan"
