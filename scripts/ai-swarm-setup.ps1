#Requires -Version 5.1
<#
.SYNOPSIS
    Dominus Node AI Swarm — Windows Setup Script

.DESCRIPTION
    Sets up the AI swarm environment on a Windows machine with an NVIDIA GPU.
    Installs Python dependencies, configures the inference server (Ollama or SGLang),
    downloads the AI model, and creates .env.swarm configuration.

    Architecture:
      ONE model instance on GPU serves ALL agent threads.
      SGLang/Ollama handles concurrent requests via batched inference.
      The model uses ~5-12GB VRAM; remaining VRAM is KV cache for concurrency.

    VRAM budget (32GB RTX 5090):
      Model weights:  ~6.6GB (Qwen3.5-9B Q4) or ~24GB (Qwen3.5-35B-A3B Q4)
      KV cache:       ~4-8GB (scales with concurrent requests)
      CUDA overhead:  ~2GB
      Total:          ~13-30GB → supports 10-50+ concurrent agent threads

.PARAMETER ServerBackend
    Inference server: "ollama" (recommended, simplest) or "sglang" (advanced).
    Default: ollama

.PARAMETER Model
    HuggingFace model ID or Ollama model tag.
    Default: qwen3.5:9b (for Ollama) or Qwen/Qwen3.5-9B (for SGLang)

.PARAMETER ApiBase
    Dominus Node API server URL. Default: http://localhost:3000

.PARAMETER SkipPython
    Skip Python installation check (if you manage Python separately).

.EXAMPLE
    .\ai-swarm-setup.ps1
    .\ai-swarm-setup.ps1 -ServerBackend sglang -Model "Qwen/Qwen3.5-9B"
    .\ai-swarm-setup.ps1 -ServerBackend ollama -Model "qwen3.5:9b"
#>

[CmdletBinding()]
param(
    [ValidateSet("ollama", "sglang")]
    [string]$ServerBackend = "ollama",

    [string]$Model = "",

    [string]$ApiBase = "http://localhost:3000",

    [switch]$SkipPython
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Dominus Node AI Swarm — Windows Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Backend:  $ServerBackend"
Write-Host "  Repo:     $RepoRoot"
Write-Host ""

# ─── Helper Functions ───────────────────────────────────────────────

function Test-CommandExists {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Write-Step {
    param([string]$Message)
    Write-Host "  [*] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "  [X] $Message" -ForegroundColor Red
}

# ─── Step 1: Check NVIDIA GPU ──────────────────────────────────────

Write-Host "Step 1: Checking GPU..." -ForegroundColor White

if (Test-CommandExists "nvidia-smi") {
    $gpuName = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1
    $gpuVram = & nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>$null | Select-Object -First 1
    $cudaVer = & nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1
    Write-Step "GPU: $gpuName ($gpuVram)"
    Write-Step "Driver: $cudaVer"
} else {
    Write-Warn "nvidia-smi not found — install NVIDIA drivers from https://www.nvidia.com/drivers/"
    Write-Warn "Continuing setup (GPU required at runtime, not install time)"
}

# ─── Step 2: Check / Install Python ────────────────────────────────

Write-Host ""
Write-Host "Step 2: Checking Python..." -ForegroundColor White

if (-not $SkipPython) {
    $pythonCmd = $null
    foreach ($cmd in @("python", "python3", "py")) {
        if (Test-CommandExists $cmd) {
            $ver = & $cmd --version 2>&1
            if ($ver -match "Python 3\.(\d+)") {
                $minor = [int]$Matches[1]
                if ($minor -ge 10) {
                    $pythonCmd = $cmd
                    Write-Step "Found: $ver ($cmd)"
                    break
                }
            }
        }
    }

    if (-not $pythonCmd) {
        Write-Err "Python 3.10+ not found!"
        Write-Host ""
        Write-Host "  Install Python from: https://www.python.org/downloads/" -ForegroundColor Yellow
        Write-Host "  Make sure to check 'Add Python to PATH' during installation." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Or install via winget:" -ForegroundColor Yellow
        Write-Host "    winget install Python.Python.3.12" -ForegroundColor Gray
        Write-Host ""
        exit 1
    }
} else {
    $pythonCmd = "python"
    Write-Step "Skipping Python check (--SkipPython)"
}

# ─── Step 3: Install Python dependencies ──────────────────────────

Write-Host ""
Write-Host "Step 3: Installing Python dependencies..." -ForegroundColor White

$reqFile = Join-Path $ScriptDir "requirements-ai-swarm.txt"
if (Test-Path $reqFile) {
    Write-Step "Installing from $reqFile"
    & $pythonCmd -m pip install --upgrade pip 2>&1 | Out-Null
    & $pythonCmd -m pip install -r $reqFile 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "pip install failed. Check errors above."
        exit 1
    }
    Write-Step "Core dependencies installed (requests, dominusnode)"
} else {
    Write-Warn "requirements-ai-swarm.txt not found, installing manually..."
    & $pythonCmd -m pip install requests dominusnode 2>&1
}

# ─── Step 4: Install Inference Server ──────────────────────────────

Write-Host ""
Write-Host "Step 4: Setting up $ServerBackend inference server..." -ForegroundColor White

$defaultModel = ""

if ($ServerBackend -eq "ollama") {
    $defaultModel = "qwen3.5:9b"

    if (Test-CommandExists "ollama") {
        Write-Step "Ollama already installed"
        $ollamaVer = & ollama --version 2>&1
        Write-Step "Version: $ollamaVer"
    } else {
        Write-Host ""
        Write-Host "  Ollama is not installed. Install it from:" -ForegroundColor Yellow
        Write-Host "    https://ollama.com/download/windows" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  After installing, restart this script." -ForegroundColor Yellow
        Write-Host ""

        $install = Read-Host "  Would you like to open the download page? (y/n)"
        if ($install -eq "y") {
            Start-Process "https://ollama.com/download/windows"
        }
        exit 1
    }

    # Pull model
    $modelName = if ($Model) { $Model } else { $defaultModel }
    Write-Step "Pulling model: $modelName (this may take a few minutes)..."
    & ollama pull $modelName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to pull model $modelName"
        exit 1
    }
    Write-Step "Model $modelName ready"

} elseif ($ServerBackend -eq "sglang") {
    $defaultModel = "Qwen/Qwen3.5-9B"

    Write-Step "Installing SGLang + PyTorch..."
    Write-Warn "SGLang requires CUDA 12.1+ and PyTorch 2.1+"
    Write-Host ""

    # Check if torch is installed with CUDA
    $torchCuda = & $pythonCmd -c "import torch; print(torch.cuda.is_available())" 2>$null
    if ($torchCuda -ne "True") {
        Write-Host "  PyTorch with CUDA not found. Installing..." -ForegroundColor Yellow
        & $pythonCmd -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Err "PyTorch CUDA install failed"
            Write-Host "  Manual install: https://pytorch.org/get-started/locally/" -ForegroundColor Yellow
            exit 1
        }
    }
    Write-Step "PyTorch with CUDA OK"

    & $pythonCmd -m pip install "sglang[all]" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "SGLang install failed"
        exit 1
    }
    Write-Step "SGLang installed"

    $modelName = if ($Model) { $Model } else { $defaultModel }
    Write-Step "Model will be downloaded on first launch: $modelName"
}

# ─── Step 5: Create .env.swarm ─────────────────────────────────────

Write-Host ""
Write-Host "Step 5: Configuring .env.swarm..." -ForegroundColor White

$envFile = Join-Path $RepoRoot ".env.swarm"
$envExample = Join-Path $RepoRoot ".env.swarm.example"
$modelName = if ($Model) { $Model } else { $defaultModel }

if (Test-Path $envFile) {
    Write-Warn ".env.swarm already exists — skipping creation"
    Write-Step "Edit $envFile to update configuration"
} else {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Step "Copied .env.swarm.example to .env.swarm"
    } else {
        # Generate from scratch
        $envContent = @"
# ============================================================================
# Dominus Node Swarm Configuration (generated by ai-swarm-setup.ps1)
# ============================================================================

# --- Required ---
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=

# --- Credits ---
SWARM_TEAM_CREDIT=10000
SWARM_AGENT_CREDIT=500
SWARM_AGENT_PLAN=swarm-mixed

# --- Agent Behavior ---
SWARM_PASSWORD=
SWARM_BATCH_SIZE=25
SWARM_BATCH_DELAY=10
SWARM_CYCLES=5
SWARM_DELAY_SEC=5
SWARM_RES_SCRAPES=1
SWARM_DC_REQUESTS=4

# --- Posting (optional) ---
SWARM_POST_URLS=
SWARM_POST_TOKENS=

# --- Logging ---
SWARM_LOG_DIR=$env:TEMP\dominusnode-swarm

# --- Server ---
API_BASE=$ApiBase
PROXY_HOST=localhost
PROXY_PORT=8080

# --- AI Inference ---
AI_MODEL=$modelName
AI_SGLANG_PORT=8000
AI_SGLANG_TP=1
AI_SGLANG_MEM_FRAC=0.85
AI_SKIP_SERVER=$(if ($ServerBackend -eq "ollama") { "1" } else { "0" })
AI_API_BASE=$(if ($ServerBackend -eq "ollama") { "http://localhost:11434/v1" } else { "http://localhost:8000/v1" })
"@
        Set-Content -Path $envFile -Value $envContent -Encoding UTF8
        Write-Step "Created .env.swarm"
    }

    # Update model and API base in the env file based on backend
    $content = Get-Content $envFile -Raw
    $content = $content -replace "AI_MODEL=.*", "AI_MODEL=$modelName"

    if ($ServerBackend -eq "ollama") {
        $content = $content -replace "AI_SKIP_SERVER=.*", "AI_SKIP_SERVER=1"
        $content = $content -replace "AI_API_BASE=.*", "AI_API_BASE=http://localhost:11434/v1"
        # Ollama is its own server — no SGLang needed
        if ($content -notmatch "AI_API_BASE=") {
            $content += "`nAI_API_BASE=http://localhost:11434/v1"
        }
    }

    Set-Content -Path $envFile -Value $content -Encoding UTF8

    # Restrict file permissions — only current user can read
    try {
        $acl = Get-Acl $envFile
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
            "FullControl", "Allow"
        )
        $acl.AddAccessRule($rule)
        Set-Acl $envFile $acl
        Write-Step ".env.swarm permissions restricted to current user"
    } catch {
        Write-Warn "Could not restrict .env.swarm permissions: $_"
    }

    Write-Step "Updated .env.swarm for $ServerBackend backend"

    Write-Host ""
    Write-Warn "IMPORTANT: Edit .env.swarm and set ADMIN_EMAIL + ADMIN_PASSWORD"
    Write-Warn "These must match your Dominus Node admin account credentials."
}

# ─── Step 6: Verify Setup ─────────────────────────────────────────

Write-Host ""
Write-Host "Step 6: Verifying setup..." -ForegroundColor White

# Check requests
$reqOk = & $pythonCmd -c "import requests; print('ok')" 2>$null
if ($reqOk -eq "ok") {
    Write-Step "requests: OK"
} else {
    Write-Err "requests: FAILED"
}

# Check dominusnode SDK
$sdkOk = & $pythonCmd -c "import dominusnode; print('ok')" 2>$null
if ($sdkOk -eq "ok") {
    Write-Step "dominusnode SDK: OK"
} else {
    Write-Warn "dominusnode SDK: not installed (will use raw HTTP calls)"
}

# Check inference server
if ($ServerBackend -eq "ollama") {
    $ollamaRunning = $false
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) {
            $ollamaRunning = $true
        }
    } catch {}

    if ($ollamaRunning) {
        Write-Step "Ollama server: running"
    } else {
        Write-Warn "Ollama server: not running"
        Write-Host "    Start it with: ollama serve" -ForegroundColor Gray
        Write-Host "    Ollama usually auto-starts on Windows (check system tray)." -ForegroundColor Gray
    }
}

# ─── Done ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Edit .env.swarm — set ADMIN_EMAIL and ADMIN_PASSWORD" -ForegroundColor Gray
Write-Host "  2. Make sure Dominus Node API is running at $ApiBase" -ForegroundColor Gray

if ($ServerBackend -eq "ollama") {
    Write-Host "  3. Start Ollama (if not running): ollama serve" -ForegroundColor Gray
    Write-Host "  4. Run the swarm:" -ForegroundColor Gray
    Write-Host "       .\scripts\ai-swarm.ps1 10" -ForegroundColor Yellow
    Write-Host "       .\scripts\ai-swarm.ps1 50 team" -ForegroundColor Yellow
    Write-Host "       .\scripts\ai-swarm.ps1 20 solo" -ForegroundColor Yellow
} else {
    Write-Host "  3. Run the swarm (SGLang launches automatically):" -ForegroundColor Gray
    Write-Host "       .\scripts\ai-swarm.ps1 10" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Model:    $modelName" -ForegroundColor Gray
Write-Host "  Backend:  $ServerBackend" -ForegroundColor Gray
Write-Host "  Config:   $(Join-Path $RepoRoot '.env.swarm')" -ForegroundColor Gray
Write-Host ""
