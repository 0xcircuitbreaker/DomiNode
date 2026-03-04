#Requires -Version 5.1
<#
.SYNOPSIS
    Dominus Node AI Agent Swarm Launcher (Windows/PowerShell)

.DESCRIPTION
    Launches the AI swarm orchestrator on Windows. Optionally starts an inference
    server (SGLang), then runs the Python orchestrator that creates autonomous
    Dominus Node agents.

    Architecture:
      ONE model instance on GPU serves ALL agent threads via batched inference.
      This is NOT one model per agent.

    Prerequisites:
      - Run ai-swarm-setup.ps1 first to install dependencies
      - Dominus Node API + proxy gateway must be running
      - .env.swarm configured with ADMIN_EMAIL + ADMIN_PASSWORD

.PARAMETER NumAgents
    Number of agents to launch (1-500). Required.

.PARAMETER Mode
    Agent mode: "team", "solo", or "both" (default: both).
    both = 70% team + 30% solo.

.EXAMPLE
    .\ai-swarm.ps1 10              # 7 team + 3 solo
    .\ai-swarm.ps1 50 team         # 50 team agents
    .\ai-swarm.ps1 20 solo         # 20 solo agents
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    # Cap at 500 to prevent resource exhaustion
    [ValidateRange(1, 500)]
    [int]$NumAgents,

    [Parameter(Position = 1)]
    [ValidateSet("team", "solo", "both")]
    [string]$Mode = "both"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

# ─── Cleanup function (runs on normal exit AND CTRL+C) ───

$script:sglangProcess = $null
$script:ollamaStartedByUs = $false
$script:ollamaProcess = $null
$script:cleanupDone = $false

function Invoke-SwarmCleanup {
    if ($script:cleanupDone) { return }
    $script:cleanupDone = $true

    # Stop SGLang if we started it
    if ($script:sglangProcess -and -not $script:sglangProcess.HasExited) {
        Write-Host "`nStopping SGLang server (PID $($script:sglangProcess.Id))..." -ForegroundColor Gray
        Stop-Process -Id $script:sglangProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  SGLang server stopped."
    }

    # Stop Ollama if we started it
    if ($script:ollamaStartedByUs -and $script:ollamaProcess -and -not $script:ollamaProcess.HasExited) {
        Write-Host "Stopping Ollama (started by this script)..." -ForegroundColor Gray
        Stop-Process -Id $script:ollamaProcess.Id -Force -ErrorAction SilentlyContinue
    }

    # Clear credential environment variables
    foreach ($key in @("ADMIN_PASSWORD", "ADMIN_EMAIL", "SWARM_PASSWORD", "SWARM_POST_TOKENS")) {
        [Environment]::SetEnvironmentVariable($key, $null, "Process")
    }

    # Clean up credential files
    $credDir = Get-EnvOrDefault "SWARM_LOG_DIR" (Join-Path $env:TEMP "dominusnode-ai-swarm")
    foreach ($f in @("swarm-password.txt", "team-keys.txt")) {
        $path = Join-Path $credDir $f
        if (Test-Path $path) {
            Remove-Item $path -Force -ErrorAction SilentlyContinue
        }
    }
}

# Register cleanup for CTRL+C / script exit
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Invoke-SwarmCleanup } -ErrorAction SilentlyContinue | Out-Null

# ─── Load .env.swarm ───────────────────────────────────────────────

$envFile = Join-Path $RepoRoot ".env.swarm"
if (Test-Path $envFile) {
    Write-Host "Loading config from $envFile"
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $eqIdx = $line.IndexOf("=")
            if ($eqIdx -gt 0) {
                $key = $line.Substring(0, $eqIdx).Trim()
                $val = $line.Substring($eqIdx + 1).Trim()
                # Strip surrounding quotes (common .env convention)
                if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
                    ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                    if ($val.Length -ge 2) {
                        $val = $val.Substring(1, $val.Length - 2)
                    }
                }
                # Only set if not already in environment
                if (-not [Environment]::GetEnvironmentVariable($key)) {
                    [Environment]::SetEnvironmentVariable($key, $val, "Process")
                }
            }
        }
    }
}

# ─── Configuration ─────────────────────────────────────────────────

function Get-EnvOrDefault {
    param([string]$Name, [string]$Default)
    $val = [Environment]::GetEnvironmentVariable($Name)
    if ($val) { return $val } else { return $Default }
}

$AI_MODEL = Get-EnvOrDefault "AI_MODEL" "qwen3.5:9b"
$AI_SGLANG_PORT = Get-EnvOrDefault "AI_SGLANG_PORT" "8000"
$AI_SGLANG_TP = Get-EnvOrDefault "AI_SGLANG_TP" "1"
$AI_SGLANG_MEM_FRAC = Get-EnvOrDefault "AI_SGLANG_MEM_FRAC" "0.85"
$AI_SKIP_SERVER = Get-EnvOrDefault "AI_SKIP_SERVER" "1"
$AI_API_BASE = Get-EnvOrDefault "AI_API_BASE" "http://localhost:11434/v1"
$API_BASE = Get-EnvOrDefault "API_BASE" "http://localhost:3000"
$PROXY_HOST = Get-EnvOrDefault "PROXY_HOST" "localhost"
$PROXY_PORT = Get-EnvOrDefault "PROXY_PORT" "8080"
$LOG_DIR = Get-EnvOrDefault "SWARM_LOG_DIR" (Join-Path $env:TEMP "dominusnode-ai-swarm")
$ADMIN_EMAIL = Get-EnvOrDefault "ADMIN_EMAIL" ""
$ADMIN_PASSWORD = Get-EnvOrDefault "ADMIN_PASSWORD" ""

# Validate numeric parameters
if ($AI_SGLANG_PORT -notmatch '^\d{1,5}$' -or [int]$AI_SGLANG_PORT -gt 65535) {
    Write-Host "ERROR: AI_SGLANG_PORT must be a valid port number (1-65535)" -ForegroundColor Red
    exit 1
}
if ($AI_SGLANG_MEM_FRAC -notmatch '^\d+\.?\d*$') {
    Write-Host "ERROR: AI_SGLANG_MEM_FRAC must be a decimal number (e.g., 0.85)" -ForegroundColor Red
    exit 1
}

if (-not $ADMIN_EMAIL) {
    Write-Host "ERROR: ADMIN_EMAIL required (set in .env.swarm)" -ForegroundColor Red
    exit 1
}
if (-not $ADMIN_PASSWORD) {
    Write-Host "ERROR: ADMIN_PASSWORD required (set in .env.swarm)" -ForegroundColor Red
    exit 1
}

# Warn for large agent counts
if ($NumAgents -gt 100) {
    $totalRequests = $NumAgents * 25
    Write-Host "WARNING: $NumAgents agents will create $NumAgents accounts and ~$totalRequests proxy requests." -ForegroundColor Yellow
    $confirm = Read-Host "  Continue? (y/n)"
    if ($confirm -ne 'y') { exit 0 }
}

# Ensure log dir exists
New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null

# ─── Banner ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Dominus Node AI Agent Swarm" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Model:       $AI_MODEL"
Write-Host "  AI API:      $AI_API_BASE"
Write-Host "  Mode:        $Mode"
Write-Host "  Agents:      $NumAgents"
Write-Host "  API:         $API_BASE"
Write-Host "  Proxy:       ${PROXY_HOST}:${PROXY_PORT}"
Write-Host "  Log dir:     $LOG_DIR"
Write-Host ""

# ─── Pre-flight checks ────────────────────────────────────────────

Write-Host "Pre-flight checks..." -ForegroundColor White

# Check Python
$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.(\d+)" -and [int]$Matches[1] -ge 10) {
            $pythonCmd = $cmd
            Write-Host "  Python:  $ver" -ForegroundColor Green
            break
        }
    }
}
if (-not $pythonCmd) {
    Write-Host "  ERROR: Python 3.10+ not found" -ForegroundColor Red
    Write-Host "  Run .\scripts\ai-swarm-setup.ps1 first" -ForegroundColor Yellow
    exit 1
}

# Check required packages
$missingPkgs = @()
foreach ($pkg in @("requests")) {
    $check = & $pythonCmd -c "import $pkg" 2>&1
    if ($LASTEXITCODE -ne 0) {
        $missingPkgs += $pkg
    }
}
if ($missingPkgs.Count -gt 0) {
    Write-Host "  Missing packages: $($missingPkgs -join ', ')" -ForegroundColor Red
    Write-Host "  Run: $pythonCmd -m pip install $($missingPkgs -join ' ')" -ForegroundColor Yellow
    exit 1
}
Write-Host "  Packages: OK" -ForegroundColor Green

# Check Ollama installed (detect existing installation)
if (Get-Command "ollama" -ErrorAction SilentlyContinue) {
    $ollamaVer = & ollama --version 2>&1
    Write-Host "  Ollama:  installed ($ollamaVer)" -ForegroundColor Green
} else {
    Write-Host "  Ollama:  not installed" -ForegroundColor Yellow
}

# Check API
try {
    $healthResp = Invoke-WebRequest -Uri "$API_BASE/api/health" -TimeoutSec 5 -ErrorAction Stop
    if ($healthResp.StatusCode -eq 200) {
        Write-Host "  API:     OK" -ForegroundColor Green
    }
} catch {
    Write-Host "  ERROR: API not reachable at $API_BASE" -ForegroundColor Red
    Write-Host "  Make sure Dominus Node API is running" -ForegroundColor Yellow
    exit 1
}

# Check GPU
if (Get-Command "nvidia-smi" -ErrorAction SilentlyContinue) {
    $gpuName = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1
    $gpuVram = & nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>$null | Select-Object -First 1
    Write-Host "  GPU:     $gpuName ($gpuVram)" -ForegroundColor Green
} else {
    Write-Host "  GPU:     nvidia-smi not found (warning)" -ForegroundColor Yellow
}

Write-Host ""

# ─── Launch inference server (if needed) ───────────────────────────

# Derive Ollama health check URL from AI_API_BASE instead of hardcoding
$ollamaBaseUrl = $AI_API_BASE -replace '/v1/?$', ''
$ollamaHealthUrl = "$ollamaBaseUrl/api/tags"
# Detect Ollama by checking if ollama command exists OR the URL contains :11434
$isOllamaBackend = (Get-Command "ollama" -ErrorAction SilentlyContinue) -or ($AI_API_BASE -match ':11434(/|$)')

if ($AI_SKIP_SERVER -eq "1") {
    Write-Host "Using external AI API at $AI_API_BASE" -ForegroundColor Gray

    if ($isOllamaBackend) {
        try {
            $ollamaResp = Invoke-WebRequest -Uri $ollamaHealthUrl -TimeoutSec 3 -ErrorAction Stop
            Write-Host "  Ollama: running" -ForegroundColor Green
        } catch {
            Write-Host "  Ollama not running — starting..." -ForegroundColor Yellow
            # Track Ollama process for cleanup
            $script:ollamaProcess = Start-Process "ollama" -ArgumentList "serve" -WindowStyle Minimized -PassThru
            $script:ollamaStartedByUs = $true
            Start-Sleep -Seconds 3

            # Verify it started
            try {
                Invoke-WebRequest -Uri $ollamaHealthUrl -TimeoutSec 5 -ErrorAction Stop | Out-Null
                Write-Host "  Ollama: started (PID $($script:ollamaProcess.Id))" -ForegroundColor Green
            } catch {
                Write-Host "  ERROR: Could not start Ollama. Start it manually: ollama serve" -ForegroundColor Red
                exit 1
            }
        }
    }
} else {
    Write-Host "Launching SGLang server..." -ForegroundColor White
    Write-Host "  Model: $AI_MODEL"
    Write-Host "  Port:  $AI_SGLANG_PORT"
    Write-Host "  TP:    $AI_SGLANG_TP"
    Write-Host "  Mem:   $AI_SGLANG_MEM_FRAC"
    Write-Host ""

    $sglangLog = Join-Path $LOG_DIR "sglang.log"
    $sglangArgs = "-m sglang.launch_server --model-path `"$AI_MODEL`" --port $AI_SGLANG_PORT --tp $AI_SGLANG_TP --mem-fraction-static $AI_SGLANG_MEM_FRAC --host 127.0.0.1"
    $script:sglangProcess = Start-Process -FilePath $pythonCmd -ArgumentList $sglangArgs `
        -RedirectStandardOutput $sglangLog -RedirectStandardError (Join-Path $LOG_DIR "sglang-err.log") `
        -WindowStyle Hidden -PassThru

    Write-Host "  SGLang PID: $($script:sglangProcess.Id)"
    Write-Host "  Waiting for server to be ready..."

    $maxWait = 300
    $waited = 0
    $ready = $false
    while ($waited -lt $maxWait) {
        try {
            $resp = Invoke-WebRequest -Uri "$AI_API_BASE/models" -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                $ready = $true
                Write-Host "  SGLang server ready! (${waited}s)" -ForegroundColor Green
                break
            }
        } catch {
            # Log non-transient errors during startup
            if ($_.Exception.Message -notmatch 'Unable to connect|connection refused|timeout') {
                Write-Host "  Warning: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }

        if ($script:sglangProcess.HasExited) {
            Write-Host "  ERROR: SGLang server died during startup. Check $sglangLog" -ForegroundColor Red
            exit 1
        }

        Start-Sleep -Seconds 5
        $waited += 5
        Write-Host "  Waiting... ${waited}/${maxWait}s" -NoNewline
        Write-Host "`r" -NoNewline
    }

    if (-not $ready) {
        Write-Host ""
        Write-Host "  ERROR: SGLang server did not start within ${maxWait}s" -ForegroundColor Red
        Stop-Process -Id $script:sglangProcess.Id -Force -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host ""
}

# ─── Launch AI orchestrator ───────────────────────────────────────

Write-Host "Launching AI swarm orchestrator..." -ForegroundColor White
Write-Host ""

# Set environment for orchestrator
$env:DOMINUSNODE_BASE_URL = $API_BASE
$env:DOMINUSNODE_PROXY_HOST = $PROXY_HOST
$env:DOMINUSNODE_HTTP_PROXY_PORT = $PROXY_PORT
$env:AI_API_BASE = $AI_API_BASE
$env:AI_MODEL = $AI_MODEL
$env:ADMIN_EMAIL = $ADMIN_EMAIL
$env:ADMIN_PASSWORD = $ADMIN_PASSWORD
# Unbuffered Python output for real-time log streaming
$env:PYTHONUNBUFFERED = "1"

$orchestratorScript = Join-Path $ScriptDir "ai-swarm-orchestrator.py"
if (-not (Test-Path $orchestratorScript)) {
    Write-Host "ERROR: ai-swarm-orchestrator.py not found at $orchestratorScript" -ForegroundColor Red
    exit 1
}

$orchLog = Join-Path $LOG_DIR "orchestrator.log"
$orchExit = 0

# try/finally ensures cleanup runs even on CTRL+C
try {
    & $pythonCmd -u $orchestratorScript `
        --num-agents $NumAgents `
        --mode $Mode `
        --api-base $API_BASE `
        --proxy-host $PROXY_HOST `
        --proxy-port $PROXY_PORT `
        --log-dir $LOG_DIR 2>&1 | Tee-Object -FilePath $orchLog

    $orchExit = $LASTEXITCODE
} catch {
    Write-Host "Orchestrator error: $_" -ForegroundColor Red
    $orchExit = 1
} finally {
    Invoke-SwarmCleanup
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
if ($orchExit -eq 0) {
    Write-Host "  AI Swarm Complete (success)" -ForegroundColor Green
} else {
    Write-Host "  AI Swarm Complete (exit code: $orchExit)" -ForegroundColor Yellow
}
Write-Host "  Logs: $LOG_DIR" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Cyan

exit $orchExit
