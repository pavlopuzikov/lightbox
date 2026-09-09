# Republishes the manifest AriOS's /lightbox reads, and gets it to AriOS.
#
# AriOS renders that page from a snapshot rather than from the hub, on purpose:
# a page on the internet must not depend on this laptop being awake (see
# apps/ari-app/lib/lightbox.ts). It reads the vault over the GitHub API, so
# writing the file locally is only half the job. Until the vault is committed
# and pushed, nothing outside this machine can see the new manifest, which is
# what `lightbox publish` means by "Commit the vault to make it visible".
#
# Writes exactly one file, the tool's own generated output:
#   04 - Projects & Outputs/Lightbox/published/manifest.json
# It touches no hand-written note. It carries no bytes and no secrets, but it
# does name every project in the catalogue, including the Barnes cluster, and
# the vault repo is private. That was already true of the copy published on
# 7 Sept; this only keeps it current.
#
# Unattended safety, in order of how much damage the mistake would do:
#   - Only ever stages that one path. The vault's own auto-sync and the Telegram
#     bot both write here, so a `git add -A` from a background task would sweep
#     up half-finished notes and push them.
#   - If the rebase does not go cleanly it aborts and stops WITHOUT pushing.
#     Ari/Activity Log.md conflicts are normal here (the bot appends to it
#     constantly) and they have to be resolved by interleaving on timestamp,
#     which is a human's job, not a task's.
#   - Does nothing at all when the manifest came out byte-identical, so a daily
#     run on a quiet day adds no commit.

$ErrorActionPreference = 'Stop'
$repo  = Split-Path -Parent $PSScriptRoot
$vault = 'C:\Users\ppuzi\OneDrive\Desktop\KW\Knowledge Web Vault'
$rel   = '04 - Projects & Outputs/Lightbox/published/manifest.json'
$log   = Join-Path $repo '.lightbox\publish.log'

function Say($msg) {
  $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg
  Add-Content -Path $log -Value $line -Encoding utf8
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null

$before = if (Test-Path (Join-Path $vault $rel)) { (Get-FileHash (Join-Path $vault $rel)).Hash } else { '' }

Push-Location $repo
try {
  $out = & node bin\lightbox.mjs publish 2>&1
  if ($LASTEXITCODE -ne 0) { Say "publish FAILED ($LASTEXITCODE): $out"; exit 1 }
  Say ($out -join ' | ')
} finally { Pop-Location }

$after = (Get-FileHash (Join-Path $vault $rel)).Hash
if ($after -eq $before) { Say 'manifest unchanged, nothing to commit'; exit 0 }

Push-Location $vault
try {
  # Bring the bot's writes down first. --autostash because Obsidian may have
  # left the tree dirty; the stash is restored by git itself afterwards.
  & git pull --rebase --autostash origin main 2>&1 | ForEach-Object { Say "pull: $_" }
  if ($LASTEXITCODE -ne 0) {
    & git rebase --abort 2>&1 | Out-Null
    Say 'pull did not apply cleanly. Rebase aborted, NOTHING pushed. Resolve by hand.'
    exit 1
  }

  & git add -- $rel
  # -- so a path that starts with a dash or contains spaces is never read as a flag.
  $staged = & git diff --cached --name-only -- $rel
  if (-not $staged) { Say 'file changed but git sees no diff (line endings?), nothing to commit'; exit 0 }

  & git commit -m "chore(lightbox): refresh the published manifest" -- $rel 2>&1 | ForEach-Object { Say "commit: $_" }
  if ($LASTEXITCODE -ne 0) { Say "commit FAILED ($LASTEXITCODE)"; exit 1 }

  & git push origin main 2>&1 | ForEach-Object { Say "push: $_" }
  if ($LASTEXITCODE -ne 0) { Say "push FAILED ($LASTEXITCODE). Commit is local only."; exit 1 }
  Say 'pushed'
} finally { Pop-Location }
