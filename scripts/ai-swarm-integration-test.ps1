#Requires -Version 5.1
<#
.SYNOPSIS
    Dominus Node Integration Swarm Tester (Windows/PowerShell)

.DESCRIPTION
    Tests each AI integration (LangChain, CrewAI, LlamaIndex, AutoGPT, etc.)
    by creating agents that USE the actual plugins, then generates social posts
    about the experience to attract real AI agent users.

.PARAMETER Integrations
    Which integrations to test. Default: all.
    Options: langchain, crewai, llamaindex, autogpt, agent-zero, pydantic-ai, raw-http

.PARAMETER CreditCents
    Wallet credit per integration test account. Default: 1000 ($10).

.EXAMPLE
    .\ai-swarm-integration-test.ps1                           # Test all
    .\ai-swarm-integration-test.ps1 -Integrations langchain crewai
    .\ai-swarm-integration-test.ps1 -Integrations raw-http    # No packages needed
#>

[CmdletBinding()]
param(
    [string[]]$Integrations = @("all"),
    [int]$CreditCents = 1000
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

# Load .env.swarm
$envFile = Join-Path $RepoRoot ".env.swarm"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $eqIdx = $line.IndexOf("=")
            if ($eqIdx -gt 0) {
                $key = $line.Substring(0, $eqIdx).Trim()
                $val = $line.Substring($eqIdx + 1).Trim()
                if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
                    ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                    if ($val.Length -ge 2) { $val = $val.Substring(1, $val.Length - 2) }
                }
                if (-not [Environment]::GetEnvironmentVariable($key)) {
                    [Environment]::SetEnvironmentVariable($key, $val, "Process")
                }
            }
        }
    }
}

# Find Python
$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.(\d+)" -and [int]$Matches[1] -ge 10) {
            $pythonCmd = $cmd
            break
        }
    }
}
if (-not $pythonCmd) {
    Write-Host "ERROR: Python 3.10+ not found" -ForegroundColor Red
    exit 1
}

$env:PYTHONUNBUFFERED = "1"

$API_BASE = if ([Environment]::GetEnvironmentVariable("API_BASE")) {
    [Environment]::GetEnvironmentVariable("API_BASE")
} else { "http://localhost:3000" }

$PROXY_HOST = if ([Environment]::GetEnvironmentVariable("PROXY_HOST")) {
    [Environment]::GetEnvironmentVariable("PROXY_HOST")
} else { "localhost" }

$PROXY_PORT = if ([Environment]::GetEnvironmentVariable("PROXY_PORT")) {
    [Environment]::GetEnvironmentVariable("PROXY_PORT")
} else { "8080" }

$LOG_DIR = Join-Path $env:TEMP "dominusnode-integration-test"

$script = Join-Path $ScriptDir "ai-swarm-integration-test.py"

$intArgs = @()
foreach ($i in $Integrations) {
    $intArgs += $i
}

try {
    & $pythonCmd -u $script `
        --api-base $API_BASE `
        --proxy-host $PROXY_HOST `
        --proxy-port $PROXY_PORT `
        --log-dir $LOG_DIR `
        --credit-cents $CreditCents `
        --integrations @intArgs

    $exitCode = $LASTEXITCODE
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    foreach ($key in @("ADMIN_PASSWORD", "SWARM_PASSWORD")) {
        [Environment]::SetEnvironmentVariable($key, $null, "Process")
    }
}

exit $exitCode
