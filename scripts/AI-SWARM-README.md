# Dominus Node AI Agent Swarm

Run autonomous AI agents that register, proxy traffic, and generate social posts — all powered by a local LLM on your RTX 5090.

## Architecture

```
                          RTX 5090 (32GB VRAM)
                     ┌────────────────────────────┐
                     │   ONE model instance        │
                     │   (Qwen3.5-9B or 35B-A3B)   │
                     │   serves ALL agent threads   │
                     │   via batched inference       │
                     └────────────┬───────────────┘
                                  │ OpenAI-compatible API (:8000 or :11434)
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
         Agent #1            Agent #2            Agent #N
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                     ┌────────────┴───────────────┐
                     │   Dominus Node Backend      │
                     │   REST API (:3000)           │
                     │   Proxy Gateway (:8080)      │
                     └────────────────────────────┘
```

**Key insight:** One GPU model instance handles ALL agents. SGLang/Ollama batches concurrent requests via RadixAttention (shared prefix caching). This is NOT one model per agent.

**VRAM budget (32GB):**
| Component | Usage |
|-----------|-------|
| Model weights | 5-12 GB (depends on model) |
| KV cache | 4-8 GB (scales with concurrency) |
| CUDA overhead | ~2 GB |
| **Headroom** | **10-15 GB for 10-50 concurrent agents** |

## Quick Start (5090 Machine)

### 1. Clone and install

```bash
git clone https://64.176.195.20/0xcircuitbreaker/DomiNode.git
cd DomiNode
npm install
npm run build
```

### 2. Start the backend

```bash
# Start PostgreSQL
docker compose up -d

# Apply schema
npm run db:migrate

# Copy .env.example → .env and fill in credentials
cp .env.example .env
# Edit .env: set DATABASE_URL, WEBSHARE_API_KEY, STRIPE/NOWPAYMENTS keys

# Start services (two terminals or use tmux)
npm run start:api    # REST API on :3000
npm run start:proxy  # Proxy gateway on :8080
```

### 3. Configure the swarm

```bash
cp .env.swarm.example .env.swarm
```

Edit `.env.swarm`:

```bash
# REQUIRED — admin account to credit agent wallets
ADMIN_EMAIL=your-admin@email.com
ADMIN_PASSWORD=your-admin-password

# Credits (in cents)
SWARM_TEAM_CREDIT=10000        # $100 for team wallet
SWARM_AGENT_CREDIT=500         # $5 per solo agent

# Agent behavior
SWARM_CYCLES=5                 # Proxy cycles per agent
SWARM_RES_SCRAPES=1            # Residential requests per cycle
SWARM_DC_REQUESTS=4            # Datacenter requests per cycle
SWARM_DELAY_SEC=5              # Delay between requests
SWARM_BATCH_SIZE=25            # Agents per batch
SWARM_BATCH_DELAY=10           # Seconds between batches

# Server (if running backend on different machine)
API_BASE=http://localhost:3000
PROXY_HOST=localhost
PROXY_PORT=8080
```

### 4. Install AI dependencies

```bash
pip install dominusnode crewai requests sglang[all]
# OR for Ollama backend (simpler):
pip install dominusnode crewai requests
```

### 5. Choose your AI backend

#### Option A: Ollama (recommended for simplicity)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (pick one based on your GPU and strategy)
ollama pull qwen3.5:9b        # ~6.6GB, BEST VALUE — 50+ agents, beats Qwen3-30B
# OR for 32GB VRAM (fewer agents, higher quality):
ollama pull qwen3.5:27b       # ~17GB dense, BEST QUALITY — BFCL 68.5, beats GPT-5 mini
ollama pull qwen3.5:35b-a3b   # ~24GB MoE, FAST+SMART — 4x faster than 27B, near-same quality
# OR for 6GB VRAM:
ollama pull qwen3.5:4b         # ~3.4GB, multimodal, 262K context

# Ollama runs automatically on :11434
```

Add to `.env.swarm`:
```bash
AI_MODEL=qwen3.5:9b
AI_SKIP_SERVER=1
AI_API_BASE=http://localhost:11434/v1
```

#### Option B: SGLang (recommended for max throughput)

SGLang gives ~29% higher throughput than vLLM for multi-agent workloads (RadixAttention prefix sharing).

```bash
pip install "sglang[all]"

# Launch manually (or let ai-swarm.sh do it):
python3 -m sglang.launch_server \
  --model-path Qwen/Qwen3.5-9B \
  --port 8000 \
  --tp 1 \
  --mem-fraction-static 0.85 \
  --host 127.0.0.1
```

Add to `.env.swarm`:
```bash
AI_MODEL=Qwen/Qwen3.5-9B
AI_SKIP_SERVER=0              # ai-swarm.sh will launch SGLang
AI_SGLANG_PORT=8000
AI_SGLANG_TP=1                # Tensor parallel (1 for single GPU)
AI_SGLANG_MEM_FRAC=0.85       # GPU memory fraction
```

### 6. Run the swarm

There are **three launchers** depending on what you need:

---

#### A. AI Swarm (AI-powered agents with local LLM)

```bash
# Both modes: 70% team + 30% solo (default)
./scripts/ai-swarm.sh 20

# Team only (shared wallet)
./scripts/ai-swarm.sh 50 team

# Solo only (individual accounts)
./scripts/ai-swarm.sh 10 solo
```

**What it does:**
1. Launches SGLang server (if `AI_SKIP_SERVER=0`)
2. Waits for model to load (~30-120s depending on model size)
3. Runs the Python orchestrator (`ai-swarm-orchestrator.py`)
4. Each agent: registers, gets API key, runs proxy cycles, generates AI social posts
5. AI decides per-cycle actions (scrape/post/check)
6. Saves results to `/tmp/dominusnode-ai-swarm/results.json`

---

#### B. Shell Swarm (no AI model needed)

```bash
# Both modes
./scripts/swarm.sh 200

# Team only
./scripts/swarm.sh 50 team

# Solo only
./scripts/swarm.sh 50 solo
```

**What it does:**
1. Pre-flight checks (API, proxy health)
2. Admin authenticates
3. Creates team + team API keys (team mode)
4. Launches bash sub-agents in parallel batches
5. Each agent runs proxy cycles with smart pool routing:
   - Residential for: Google, LinkedIn, Indeed, Glassdoor
   - Datacenter for everything else (saves bandwidth)
6. Template-based social posts (no AI needed)

---

#### C. Integration Test Swarm (tests all AI framework plugins)

```bash
# Test all integrations
python3 scripts/ai-swarm-integration-test.py --api-base http://localhost:3000

# Test specific ones
python3 scripts/ai-swarm-integration-test.py \
  --integrations langchain crewai llamaindex autogpt agent-zero

# List available
python3 scripts/ai-swarm-integration-test.py --list
```

**What it does:**
1. For each integration (LangChain, CrewAI, LlamaIndex, AutoGPT, Agent Zero, etc.):
   - Creates a test account + credits wallet
   - Tests the plugin's authenticate/balance/fetch/usage tools
   - Generates AI social posts about the experience
2. Validates all 23+ published integrations work end-to-end

---

## Recommended Models

### RTX 3060 Mobile (6GB VRAM)

With 6GB, you need Q4 models under ~3.5GB to leave room for KV cache + CUDA overhead.

| Model | VRAM (Q4) | Tool Calling | Ollama Tag | Agents | Notes |
|-------|-----------|-------------|------------|--------|-------|
| **Qwen3.5-4B** (recommended) | ~3.4 GB | Native | `qwen3.5:4b` | 5-10 | Mar 2026; 262K context, multimodal, GPQA 76.2 — beats Qwen3-8B on reasoning |
| Qwen3.5-2B | ~1.9 GB | Native | `qwen3.5:2b` | 10-15 | Mar 2026; 262K context, multimodal, native tool calling at 2B |
| Qwen3-4B | ~2.5 GB | Native | `qwen3:4b` | 5-10 | Previous gen; still solid tool-call accuracy |
| Gemma 3 4B QAT | ~2.6 GB | Native | `gemma3:4b-it-q4_K_M` | 5-10 | Google QAT retains near-BF16 quality at int4 |
| Phi-4-mini 3.8B | ~2.5 GB | Built-in | `phi4-mini:3.8b-q4_K_M` | 5-10 | Strong STEM reasoning; Microsoft synthetic data training |
| Qwen3.5-0.8B | ~1 GB | Limited | `qwen3.5:0.8b` | 20-30 | Mar 2026; ultra-light edge model, max concurrency |
| SmolLM3 3B | ~2 GB | Hermes | `smollm3` | 5-10 | 128K context; competitive with 4B models |

### RTX 5090 (32GB VRAM)

Qwen 3.5 (Feb-Mar 2026) is a generational leap: the 9B dense beats the previous Qwen3-30B, and the 27B dense beats GPT-5 mini + Claude Sonnet 4.5 on agentic benchmarks.

| Model | Params (Total/Active) | VRAM (Q4) | Ollama Tag | Agents | Speed | Notes |
|-------|-----------------------|-----------|------------|--------|-------|-------|
| **Qwen3.5-27B** (best quality) | 27B dense | ~17 GB | `qwen3.5:27b` | 5-10 | ~20 tok/s | BFCL 68.5, SWE-bench 72.4, beats GPT-5 mini |
| **Qwen3.5-35B-A3B** (fast+smart) | 35B / 3B MoE | ~24 GB | `qwen3.5:35b-a3b` | 10-20 | ~80 tok/s | BFCL 67.3, 4x faster than 27B, near-same quality |
| **Qwen3.5-9B** (best value) | 9B dense | ~6.6 GB | `qwen3.5:9b` | 30-50+ | ~70 tok/s | GPQA 81.7, beats Qwen3-30B; 262K ctx |
| Qwen3.5-27B Q8 (max quality) | 27B dense | ~30 GB | `qwen3.5:27b-q8_0` | 1-3 | ~15 tok/s | Highest fidelity, tight VRAM fit |
| Qwen3-Coder-30B-A3B | 30B / 3.3B MoE | ~18 GB | `qwen3-coder:30b-a3b` | 10-20 | ~80 tok/s | No-thinking mode; purpose-built for tool use |
| GLM-4.7-Flash | 30B / 3B MoE | ~18 GB | `glm-4.7-flash` | 10-20 | ~100 tok/s | Jan 2026; strong tau-Bench scores |
| Mistral Small 3.2 | 24B dense | ~14 GB | `mistral-small3.2:24b` | 15-25 | ~25 tok/s | Apache 2.0; 128K context |
| Qwen3.5-4B (max concurrency) | 4B dense | ~3.4 GB | `qwen3.5:4b` | 50-80+ | ~100 tok/s | Leaves ~28GB for KV cache; GPQA 76.2 |

#### Qwen3.5-27B vs 35B-A3B vs 9B — Head-to-Head

| Benchmark | Qwen3.5-27B | Qwen3.5-35B-A3B | Qwen3.5-9B | GPT-5 mini | Claude Sonnet 4.5 |
|-----------|------------|-----------------|-----------|-----------|------------------|
| MMLU-Pro | **86.1** | 85.3 | 82.5 | 83.7 | 80.8 |
| GPQA Diamond | **85.5** | 84.2 | 81.7 | 82.8 | 80.1 |
| BFCL-v4 (tool use) | **68.5** | 67.3 | — | 55.5 | 54.8 |
| SWE-bench Verified | **72.4** | 69.2 | — | 72.0 | 62.0 |
| IFEval (instruction) | **95.0** | 91.9 | 91.5 | — | — |
| HMMT Feb 25 (math) | **92.0** | 89.0 | 83.2 | 89.2 | 90.0 |
| LiveCodeBench v6 | **80.7** | 74.6 | — | 80.5 | 82.7 |

#### VRAM & Concurrency on 32GB

| Model | VRAM (Q4) | Free for KV | Concurrent Agents | tok/s |
|-------|-----------|------------|-------------------|-------|
| Qwen3.5-4B | 3.4 GB | ~28 GB | **50-80+** | ~100 |
| Qwen3.5-9B | 6.6 GB | ~25 GB | **30-50+** | ~70 |
| Qwen3.5-27B | 17 GB | ~14 GB | **5-10** | ~20 |
| Qwen3.5-35B-A3B | 24 GB | ~8 GB | **10-20** | ~80 |
| Qwen3.5-27B Q8 | 30 GB | ~2 GB | **1-3** | ~15 |

#### Choosing Your Strategy

| Strategy | Model | Why |
|----------|-------|-----|
| **Max post quality** | `qwen3.5:27b` | BFCL 68.5, SWE-bench 72.4 — best reasoning and writing. 5-10 agents at ~20 tok/s |
| **Quality + speed** | `qwen3.5:35b-a3b` | Near-27B quality at 4x the speed. 10-20 agents at ~80 tok/s. Only 3B params active per token |
| **Best value (recommended)** | `qwen3.5:9b` | Beats prev-gen 30B models. 30-50 agents at ~70 tok/s. Leaves 25GB for KV cache |
| **Max concurrency** | `qwen3.5:4b` | 50-80+ agents at ~100 tok/s. Great for massive swarms with simpler posts |

**Note:** Our swarm uses plain chat completions for post generation (not tool calling), so all models work correctly on Ollama despite known tool-calling bugs in Ollama's Qwen3.5 template (issue #14493).

## Swarm Modes

### Team Mode
- Creates one team with a shared wallet
- Admin credits the team wallet (default $100)
- Each agent gets a team API key
- All proxy usage bills to the team wallet
- Best for: simulating enterprise/team usage

### Solo Mode
- Each agent registers its own account
- Admin credits each agent's wallet (default $5 each)
- Each agent creates its own API key
- Independent billing per agent
- Best for: simulating individual user signups

### Both Mode (default)
- 70% team agents + 30% solo agents
- Tests both billing paths simultaneously
- Most realistic simulation

## Environment Variables Reference

### Required
| Variable | Description |
|----------|-------------|
| `ADMIN_EMAIL` | Admin account email |
| `ADMIN_PASSWORD` | Admin account password |

### Agent Behavior
| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_CYCLES` | 5 | Proxy cycles per agent |
| `SWARM_RES_SCRAPES` | 1 | Residential requests per cycle |
| `SWARM_DC_REQUESTS` | 4 | Datacenter requests per cycle |
| `SWARM_DELAY_SEC` | 5 | Seconds between requests |
| `SWARM_BATCH_SIZE` | 25 | Agents launched per batch |
| `SWARM_BATCH_DELAY` | 10 | Seconds between batches |

### Credits
| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_TEAM_CREDIT` | 10000 | Cents to credit team wallet ($100) |
| `SWARM_AGENT_CREDIT` | 500 | Cents per solo agent wallet ($5) |
| `SWARM_AGENT_PLAN` | swarm-mixed | Plan to assign agents |

### AI Model
| Variable | Default | Description |
|----------|---------|-------------|
| `AI_MODEL` | `qwen3.5:9b` | Ollama tag or HuggingFace model ID |
| `AI_SKIP_SERVER` | 0 | Set to 1 to use external AI API (Ollama) |
| `AI_API_BASE` | `http://localhost:8000/v1` | OpenAI-compatible API URL |
| `AI_SGLANG_PORT` | 8000 | SGLang API port |
| `AI_SGLANG_TP` | 1 | Tensor parallel degree |
| `AI_SGLANG_MEM_FRAC` | 0.85 | GPU memory fraction for SGLang |

### Server
| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE` | `http://localhost:3000` | Dominus Node REST API |
| `PROXY_HOST` | `localhost` | Proxy gateway host |
| `PROXY_PORT` | 8080 | Proxy gateway port |

### Posting (Optional)
| Variable | Description |
|----------|-------------|
| `SWARM_POST_URLS` | Comma-separated social API endpoints |
| `SWARM_POST_TOKENS` | Comma-separated auth tokens for posting |

## Bandwidth Estimation

Each agent per run uses approximately:
- **Residential:** `RES_SCRAPES * CYCLES * ~100 KB` = 500 KB default
- **Datacenter:** `DC_REQUESTS * CYCLES * ~5 KB` = 100 KB default

| Agents | Residential | Datacenter | Est. Cost |
|--------|------------|------------|-----------|
| 10 | ~5 MB | ~1 MB | ~$0.03 |
| 50 | ~25 MB | ~5 MB | ~$0.15 |
| 200 | ~100 MB | ~20 MB | ~$0.60 |
| 1000 | ~500 MB | ~100 MB | ~$3.00 |

**Caps:** Residential 25 GB/mo (Webshare), Datacenter 1 TB/mo.

## File Reference

```
scripts/
├── ai-swarm.sh                  # AI swarm launcher (Linux) — SGLang + orchestrator
├── ai-swarm.ps1                 # AI swarm launcher (Windows) — Ollama + orchestrator
├── ai-swarm-setup.ps1           # Windows setup wizard (installs deps, downloads model)
├── ai-swarm-orchestrator.py     # Python AI orchestrator (all modes, AI post generation)
├── ai-swarm-integration-test.py # Tests all AI integration plugins end-to-end
├── ai-swarm-integration-test.ps1# Windows wrapper for integration test
├── swarm.sh                     # Shell swarm launcher (no AI, bash agents)
├── swarm-launch.sh              # Team mode entry point (pre-flight + admin auth)
├── swarm-launch-solo.sh         # Solo mode entry point
├── swarm-main-agent.sh          # Team orchestrator (creates team + keys + sub-agents)
├── swarm-agent.sh               # Team sub-agent (receives team API key)
├── swarm-agent-solo.sh          # Solo sub-agent (registers own account)
└── AI-SWARM-README.md           # This file
```

## Dry Run Mode

Test your configuration without a running backend, GPU, or network access:

```bash
# Validate shell swarm config
./scripts/swarm.sh 200 both --dry-run

# Validate AI swarm config (also checks GPU, Ollama, SGLang)
./scripts/ai-swarm.sh 20 team --dry-run

# Validate solo mode
./scripts/swarm.sh 50 solo --dry-run
```

**What dry-run does:**
- Validates all configuration (agent count, mode, env vars)
- Calculates bandwidth estimates
- Checks available tools (Python, Ollama, SGLang, GPU)
- Recommends models based on detected GPU VRAM
- Skips all API calls, proxy connections, and authentication
- Reports what *would* happen with current config

**What dry-run does NOT do:**
- Does not contact the backend API or proxy
- Does not register accounts or create API keys
- Does not launch SGLang or download models
- Does not use any GPU resources

Use `--dry-run` on a new machine to verify the environment before running for real.

## Troubleshooting

### SGLang won't start
- Check VRAM: `nvidia-smi` — model needs enough free VRAM
- Try reducing `AI_SGLANG_MEM_FRAC` to 0.7
- Try a smaller model: `qwen3.5:9b` (6.6GB) or `qwen3.5:4b` (3.4GB)
- Check logs: `cat /tmp/dominusnode-ai-swarm/sglang.log`

### Ollama model not found
```bash
ollama list                    # See installed models
ollama pull qwen3.5:9b         # Download if missing
curl http://localhost:11434/v1/models  # Verify API works
```

### API not reachable
```bash
curl http://localhost:3000/api/health   # Should return 200
npm run start:api                        # Start if not running
```

### Proxy not responding
```bash
curl -x http://test:test@localhost:8080 http://httpbin.org/ip
npm run start:proxy                      # Start if not running
```

### Agents failing to register
- Check PostgreSQL is running: `docker compose ps`
- Check schema is applied: `npm run db:migrate`
- Check admin credentials in `.env.swarm`

### Out of wallet balance
- Increase `SWARM_TEAM_CREDIT` or `SWARM_AGENT_CREDIT` in `.env.swarm`
- Default: $100 team, $5 per solo agent

## Example: Full 5090 Setup from Scratch

```bash
# 1. System deps
sudo apt update && sudo apt install -y docker.io docker-compose nodejs npm python3 python3-pip

# 2. NVIDIA driver + CUDA (if not already installed)
# Verify: nvidia-smi should show RTX 5090

# 3. Clone repo
git clone https://64.176.195.20/0xcircuitbreaker/DomiNode.git
cd DomiNode

# 4. Backend
npm install && npm run build
docker compose up -d
npm run db:migrate
cp .env.example .env
# Edit .env with your credentials

# 5. Start services
npm run start:api &
npm run start:proxy &

# 6. AI deps
pip install dominusnode crewai requests

# 7. Ollama (simplest path)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5:9b

# 8. Configure swarm
cp .env.swarm.example .env.swarm
# Edit: set ADMIN_EMAIL, ADMIN_PASSWORD
# Set: AI_SKIP_SERVER=1, AI_API_BASE=http://localhost:11434/v1, AI_MODEL=qwen3.5:9b

# 9. Run it
./scripts/ai-swarm.sh 20        # 14 team + 6 solo agents
```

## Windows Setup (PowerShell)

```powershell
# Run the setup wizard (installs deps, configures Ollama/SGLang, downloads model)
.\scripts\ai-swarm-setup.ps1

# Then run the swarm
.\scripts\ai-swarm.ps1 -NumAgents 20 -Mode both
```
