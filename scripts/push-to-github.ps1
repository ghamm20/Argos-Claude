# push-to-github.ps1
#
# One-shot post-auth GitHub setup for ARGOS. Run AFTER you've completed
# `gh auth login --web` in your browser. This script:
#   1. Verifies gh is authenticated
#   2. Verifies working tree is clean (or asks before pushing dirty)
#   3. Looks for an existing Argos-Claude repo on the auth'd account
#   4. If none found, creates Argos-Claude as PRIVATE (operator can
#      change visibility later via GitHub web UI or `gh repo edit`)
#   5. Adds origin remote (or updates existing one)
#   6. Pushes main (with -u) and pushes any tags
#   7. Reports the repo URL
#
# Aborts early if any step fails. Idempotent: safe to re-run if a
# previous attempt half-completed.
#
# Usage:
#   pwsh -File scripts/push-to-github.ps1
#   pwsh -File scripts/push-to-github.ps1 -Public          # create as public
#   pwsh -File scripts/push-to-github.ps1 -RepoName foo    # custom name
#   pwsh -File scripts/push-to-github.ps1 -DryRun          # print what would happen
#
# Filed at the end of the H8.5 autonomous block. The operator was at
# 14+ hours of fatigue and gh auth requires their browser; this script
# reduces the post-auth surface to a single command.

[CmdletBinding()]
param(
    [string]$RepoName = 'Argos-Claude',
    [switch]$Public,
    [switch]$DryRun,
    [string]$GhPath = 'C:\Program Files\GitHub CLI\gh.exe'
)

# Note: NOT using $ErrorActionPreference = 'Stop' globally. PS5.1 treats
# stderr from native commands (gh, git) as ErrorRecords and would abort
# the script on any stderr write — even when the command's exit code is
# 0 or when we explicitly want to inspect stderr (e.g., `gh auth status`
# when not logged in writes to stderr and exits 1, which is normal flow).
# We check $LASTEXITCODE explicitly after each native call instead.
$ErrorActionPreference = 'Continue'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [ERR] $msg" -ForegroundColor Red }

function Invoke-Or-DryRun {
    param([string]$Description, [scriptblock]$Action)
    if ($DryRun) {
        Write-Host "    [dry-run] $Description" -ForegroundColor Gray
        return $null
    }
    return & $Action
}

# ---------- Step 1: locate gh + check auth ----------
Write-Step 'Step 1: verify gh authentication'

if (-not (Test-Path $GhPath)) {
    # Fall back to PATH lookup
    $found = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if ($found) {
        $GhPath = $found
    } else {
        Write-Err "gh CLI not found at $GhPath and not on PATH."
        Write-Err 'Install with: winget install GitHub.cli'
        exit 1
    }
}
Write-Ok "gh at: $GhPath"

# Capture gh stderr without letting PS5.1 explode on NativeCommandError.
# `cmd /c "... 2>&1"` is the safest cross-PS-version workaround: cmd merges
# stderr into stdout before PowerShell sees it, so PS5.1 doesn't wrap each
# stderr line in an ErrorRecord.
$authOutput = cmd /c "`"$GhPath`" auth status 2>&1"
$authExit = $LASTEXITCODE
if ($authExit -ne 0) {
    Write-Err 'gh is not authenticated.'
    Write-Err 'Run this first in your browser (one-time setup):'
    Write-Err "  & '$GhPath' auth login --hostname github.com --git-protocol https --web"
    Write-Err ''
    Write-Err 'Then re-run this script.'
    exit 1
}
Write-Ok 'gh authenticated'

# Extract username from auth status output
$user = $null
foreach ($line in $authOutput) {
    if ($line -match 'Logged in to .* account (\S+)') {
        $user = $matches[1]
        break
    }
}
if (-not $user) {
    Write-Warn 'Could not parse username from gh auth status (will use gh API later)'
} else {
    Write-Ok "user: $user"
}

# ---------- Step 2: working-tree check ----------
Write-Step 'Step 2: verify working tree state'

$status = git status --porcelain
if ($status) {
    Write-Warn 'Working tree is not clean. Untracked or modified files:'
    git status --short
    Write-Host ''
    Write-Warn 'These will NOT be pushed (only committed changes are).'
    Write-Warn 'If you want to commit them first, Ctrl-C and do so. Otherwise:'
    if (-not $DryRun) {
        $resp = Read-Host 'Continue anyway? (y/N)'
        if ($resp -ne 'y' -and $resp -ne 'Y') {
            Write-Err 'Aborted by operator.'
            exit 1
        }
    }
} else {
    Write-Ok 'working tree clean'
}

# ---------- Step 3: look for existing repo ----------
Write-Step "Step 3: look for existing repo named $RepoName"

$existingRepoUrl = $null
$repoListJson = & $GhPath repo list --limit 200 --json nameWithOwner,url,isPrivate 2>&1
if ($LASTEXITCODE -eq 0) {
    try {
        $repos = $repoListJson | ConvertFrom-Json
        foreach ($r in $repos) {
            $name = ($r.nameWithOwner -split '/')[1]
            if ($name -eq $RepoName) {
                $existingRepoUrl = $r.url
                Write-Ok "found existing repo: $($r.nameWithOwner) ($($r.url)) private=$($r.isPrivate)"
                break
            }
        }
    } catch {
        Write-Warn "Could not parse gh repo list output: $_"
    }
}

if (-not $existingRepoUrl) {
    Write-Ok "no existing repo named $RepoName found"
}

# ---------- Step 4: create repo if needed ----------
Write-Step 'Step 4: create or link remote'

$currentRemote = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $currentRemote) {
    Write-Ok "existing origin: $currentRemote"
    if ($existingRepoUrl -and $currentRemote -notlike "*$RepoName*") {
        Write-Warn "origin points to $currentRemote but a repo named $RepoName exists at $existingRepoUrl"
        if (-not $DryRun) {
            $resp = Read-Host 'Update origin to point at the existing repo? (y/N)'
            if ($resp -eq 'y' -or $resp -eq 'Y') {
                Invoke-Or-DryRun 'git remote set-url origin' { git remote set-url origin "$existingRepoUrl.git" }
                Write-Ok "origin updated to $existingRepoUrl.git"
            }
        }
    }
} elseif ($existingRepoUrl) {
    Write-Step "linking origin → $existingRepoUrl"
    Invoke-Or-DryRun 'git remote add origin' { git remote add origin "$existingRepoUrl.git" }
    Write-Ok "origin added"
} else {
    $visibility = if ($Public) { '--public' } else { '--private' }
    Write-Step "creating $RepoName as $visibility on GitHub"
    if (-not $DryRun) {
        & $GhPath repo create $RepoName $visibility --source=. --remote=origin
        if ($LASTEXITCODE -ne 0) {
            Write-Err "gh repo create failed (exit $LASTEXITCODE)"
            exit 1
        }
    } else {
        Write-Host "    [dry-run] gh repo create $RepoName $visibility --source=. --remote=origin" -ForegroundColor Gray
    }
    Write-Ok "repo created and origin linked"
}

# ---------- Step 5: push main + tags ----------
Write-Step 'Step 5: push main + tags'

$currentBranch = git rev-parse --abbrev-ref HEAD
if ($currentBranch -ne 'main') {
    Write-Warn "current branch is '$currentBranch', not 'main'. Will push it but origin/HEAD may differ."
}

Invoke-Or-DryRun "git push -u origin $currentBranch" { git push -u origin $currentBranch }
if (-not $DryRun -and $LASTEXITCODE -ne 0) {
    Write-Err 'git push failed.'
    exit 1
}
Write-Ok "pushed $currentBranch"

$tags = (git tag) -split "`r?`n" | Where-Object { $_ }
if ($tags) {
    Write-Step "pushing $($tags.Count) tag(s)"
    foreach ($t in $tags) {
        Invoke-Or-DryRun "git push origin $t" { git push origin $t }
    }
    Write-Ok "tags pushed"
} else {
    Write-Ok '(no local tags to push)'
}

# ---------- Step 6: report ----------
Write-Step 'Step 6: report'

if (-not $DryRun) {
    $repoUrl = & $GhPath repo view --json url -q '.url' 2>$null
    if ($repoUrl) {
        Write-Host ''
        Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Green
        Write-Host "  GitHub repo:  $repoUrl" -ForegroundColor Green
        Write-Host "  Branch:       $currentBranch" -ForegroundColor Green
        if ($tags) { Write-Host "  Tags:         $($tags -join ', ')" -ForegroundColor Green }
        Write-Host '════════════════════════════════════════════════════════════════' -ForegroundColor Green
    } else {
        Write-Warn 'Could not retrieve repo URL via gh — but push succeeded.'
        Write-Host "  Origin: $(git remote get-url origin)"
    }
} else {
    Write-Host ''
    Write-Host 'DRY RUN COMPLETE — no remote changes made.'
}
