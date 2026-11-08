# Installs the Claude Background Tasks sidebar into VSCodium (or VS Code) and,
# unless -SkipPlugin is given, the Claude Code companion plugin that makes the
# stop button work.
param(
  [switch]$SkipPlugin,
  [switch]$SkipExtension
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vsix = Join-Path $here 'claude-background-tasks.vsix'

if (-not $SkipExtension) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd",
    "$env:ProgramFiles\VSCodium\bin\codium.cmd",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
  )
  $cli = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $cli) {
    $cmd = Get-Command codium, code -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $cli = $cmd.Source }
  }
  if (-not $cli) { throw 'Neither VSCodium nor VS Code was found. Install the .vsix by hand: Extensions view > ... > Install from VSIX.' }
  Write-Host "Installing the sidebar extension with $cli"
  & $cli --install-extension $vsix --force
  if ($LASTEXITCODE -ne 0) { throw "Extension install failed ($LASTEXITCODE)." }
  Write-Host 'Extension installed. Run "Developer: Reload Window" in the editor to load it.'
}

if (-not $SkipPlugin) {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Warning 'The claude CLI was not found, so the stop plugin was not installed. The list works without it; only the stop button needs it.'
  } else {
    Write-Host 'Installing the Claude Code companion plugin (stop button)'
    & claude plugin marketplace add KurtStevenK/claude-code-background-tasks
    & claude plugin install background-tasks-stop@claude-code-background-tasks
    Write-Host 'Plugin installed. It loads in Claude Code sessions started from now on.'
  }
}
