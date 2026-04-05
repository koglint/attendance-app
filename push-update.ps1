param(
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$statusLines = git status --porcelain
if (-not $statusLines) {
  Write-Host "No changes to commit."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Message)) {
  $Message = "update " + (Get-Date -Format "yyyy-MM-dd HH:mm")
}

$branch = git rev-parse --abbrev-ref HEAD
if ([string]::IsNullOrWhiteSpace($branch)) {
  throw "Could not determine the current Git branch."
}

Write-Host "Staging changes..."
git add .

Write-Host "Committing with message: $Message"
git commit -m $Message

Write-Host "Pushing to origin/$branch ..."
git push origin $branch

Write-Host "Done."
