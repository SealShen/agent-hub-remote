param(
  [string]$Repo = ".",
  [Parameter(Mandatory = $true)]
  [string]$Branch,
  [string]$Alias,
  [string]$Path,
  [string]$Base = "HEAD"
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )
  $output = & git @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join [Environment]::NewLine)
  }
  return $output
}

$repoRoot = (Invoke-Git -Args @("-C", $Repo, "rev-parse", "--show-toplevel"))[0].Trim()
if (-not $repoRoot) {
  throw "Unable to resolve repo root from '$Repo'."
}

$repoName = Split-Path $repoRoot -Leaf
$safeBranch = ($Branch -replace "[^A-Za-z0-9._/-]", "-").Trim("-")
if (-not $safeBranch) {
  throw "Branch name resolved to empty after sanitization."
}

if (-not $Alias) {
  $Alias = ($safeBranch -replace "[^A-Za-z0-9_-]", "-").Trim("-")
}

if (-not $Path) {
  $parent = Split-Path $repoRoot -Parent
  $leaf = "{0}-{1}" -f $repoName.ToLower(), ($safeBranch -replace "[/\\]", "-").ToLower()
  $Path = Join-Path $parent "worktrees\$leaf"
}

$resolvedPath = [System.IO.Path]::GetFullPath($Path)
$pathParent = Split-Path $resolvedPath -Parent
if (-not (Test-Path $pathParent)) {
  New-Item -ItemType Directory -Path $pathParent -Force | Out-Null
}

Invoke-Git -Args @("-C", $repoRoot, "worktree", "add", "-b", $Branch, $resolvedPath, $Base) | Out-Null

$markerPath = Join-Path $resolvedPath ".codex-worktree"
$markerBody = @"
branch=$Branch
created_at=$(Get-Date -Format o)
repo_root=$repoRoot
"@
Set-Content -Path $markerPath -Value $markerBody -Encoding UTF8

$snippet = [ordered]@{
  alias = $Alias
  path  = $resolvedPath
  label = "$repoName $Branch"
}

Write-Host "Created linked worktree:" -ForegroundColor Green
Write-Host "  repo   : $repoRoot"
Write-Host "  branch : $Branch"
Write-Host "  path   : $resolvedPath"
Write-Host ""
Write-Host "Add this entry to agent-hub-remote/dirs.json:" -ForegroundColor Cyan
$snippet | ConvertTo-Json -Compress
