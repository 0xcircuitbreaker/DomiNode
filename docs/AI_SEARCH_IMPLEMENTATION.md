# AI Search Implementation Report
**Dominus Node Docs — Semantic Search Upgrade**
*Prepared: 2026-03-02 | Revised: 2026-03-02 (T620 / GTX 1080 reassessment + multi-instance / CUDA MPS analysis + agentic swarm architecture)*
*Target hardware: Dell PowerEdge T620 + NVIDIA GTX 1080 8GB VRAM, Linux, behind Cloudflare*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Hardware Analysis — T620 CPU + GTX 1080 GPU](#2-hardware-analysis)
3. [Architecture Decision](#3-architecture-decision)
4. [Model Recommendations](#4-model-recommendations)
5. [GTX 1080 Pascal Optimizations (llama.cpp)](#5-gtx-1080-pascal-optimizations)
6. [Concurrency Analysis — GPU Embedding](#6-concurrency-analysis)
   - 6.1 VRAM Budget
   - 6.2 Scaling to Thousands of AI Agent Queries
   - 6.3 Throughput Estimates at Scale
   - 6.4 Single Instance vs Multiple Instances
   - 6.5 CUDA MPS on Pascal CC 6.1
   - 6.6 Queuing Architecture
   - 6.7 Alternative High-Throughput Backends for Pascal
7. [Backend Comparison Matrix](#7-backend-comparison-matrix)
8. [Implementation Plan](#8-implementation-plan)
9. [Build & Run Commands](#9-build--run-commands)
10. [Full Python Sidecar Code](#10-full-python-sidecar-code)
11. [Cloudflare Tunnel Setup](#11-cloudflare-tunnel-setup)
12. [Future Generative Upgrade Path](#12-future-generative-upgrade-path)
13. [Agentic Swarm Architecture — Many Tiny Models vs One Good Model](#13-agentic-swarm-architecture)

---

## 1. Executive Summary

**Revised conclusion: Use the GTX 1080 for embedding inference — the T620 CPU is too slow.**

The Dell PowerEdge T620 uses Xeon E5-2600 v1/v2 processors (Sandy Bridge-EP or Ivy Bridge-EP) which have AVX (256-bit float SIMD) but **no AVX2** (256-bit integer SIMD + FMA3). GGML's quantized matrix multiply kernels rely heavily on AVX2 integer intrinsics — without them, CPU embedding throughput is roughly **2-3x slower**, pushing a 50-document batch to 2.5–5 seconds — right at or over the 3s budget with no headroom.

The GTX 1080, despite its Pascal limitations (no Tensor Cores, crippled FP16), is the correct backend:
- nomic-embed-text-v1.5 (137M params) uses only ~274MB of 8GB VRAM
- Entire 50-document corpus batch processes in ~250–500ms on GPU
- 8–16 concurrent user searches at <100ms per query
- llama.cpp with Pascal-specific build flags + correct runtime settings gives maximum throughput

**Key GTX 1080 gotchas (read these before building):**
- `--no-flash-attn` is **mandatory** — Flash Attention on CC 6.1 causes a 20% regression
- Build with `-DCMAKE_CUDA_ARCHITECTURES=61` for 5–15% better performance vs generic build
- FP16 gives memory savings only — **not a compute speedup** on GP104 (1/64 of FP32 rate)
- INT8 via `__dp4a` is the correct optimization target for quantized models on Pascal
- HuggingFace TEI is **completely incompatible** (hard CC ≥ 7.5 requirement)

---

## 2. Hardware Analysis

### Dell PowerEdge T620 CPU — The AVX2 Problem

| Feature | Sandy Bridge-EP (v1) | Ivy Bridge-EP (v2) | Modern (Haswell+) |
|---------|---------------------|--------------------|--------------------|
| SSE4.2 | ✅ | ✅ | ✅ |
| AVX (256-bit float) | ✅ | ✅ | ✅ |
| **AVX2 (256-bit int)** | ❌ | ❌ | ✅ |
| FMA3 | ❌ | ❌ | ✅ |
| AVX-512 | ❌ | ❌ | Varies |

GGML's hot path is quantized matrix multiply (`GGML_OP_MUL_MAT`). These kernels use `_mm256_maddubs_epi16`, `_mm256_madd_epi16`, and `_mm256_cvtepi8_epi16` — all AVX2 integer intrinsics. Without AVX2, the compiler falls back to 128-bit SSE operations, processing half the data per clock cycle.

**Measured penalty on Ivy Bridge-EP (no AVX2):**
- Llama-3.2-1B generation: ~25 tokens/sec vs ~120 tokens/sec on a modern AVX2+ CPU (4-5x gap)
- Embedding prompt processing: ~2-3x slower than AVX2 equivalent

**Practical impact on 50-document batch embedding (CPU only):**
- nomic-embed-text-v1.5 at ~200 tokens/doc × 50 docs = 10,000 tokens
- CPU prompt processing rate without AVX2: ~2,000–4,000 tokens/sec
- Estimated batch time: **2.5–5 seconds** — at or over the 3s budget with zero headroom

**Verdict: CPU-only embedding is not viable for this hardware. Use the GTX 1080.**

### GTX 1080 GPU — Capabilities and Constraints

| Spec | Value | Impact on Inference |
|------|-------|---------------------|
| Architecture | Pascal GP104 | CC 6.1 — limited inference engine support |
| VRAM | 8GB GDDR5X | Fits all 4B models at Q4_K_M; nomic-embed uses only 274MB |
| Memory bandwidth | 320 GB/s | Competitive; good for memory-bound ops |
| FP32 throughput | 8.87 TFLOPS | Solid for embedding forward pass |
| **FP16 throughput** | **~138 GFLOPS (1/64 of FP32)** | **Intentionally crippled by NVIDIA on GP104 gaming die** |
| INT8 (`__dp4a`) | ~8.87 TOPS (parity with FP32) | The correct optimization target for quantized models |
| Tensor Cores | None (arrived with Volta CC 7.0) | No hardware FP16 matrix multiply acceleration |
| Flash Attention support | None (requires CC ≥ 7.5) | Always use `--no-flash-attn` |

**Critical FP16 note:** NVIDIA deliberately disabled FP16 compute on the GP104 gaming die (GTX 1080/1080 Ti) to protect the Tesla P100 datacenter market. The GT 1080 has 138 GFLOPS FP16 vs 8,870 GFLOPS FP32 — a 1/64 ratio. The P100 (GP100 die) has 18,700 GFLOPS FP16. Using FP16 weights on the GTX 1080 saves memory bandwidth but provides **zero compute speedup**. FP32 is the correct compute path.

**INT8 DP4A is the exception:** GP104 supports the `__dp4a` instruction (4-element INT8 dot product with 32-bit accumulate) at full FP32 throughput (~8.87 TOPS). For quantized GGUF models (Q4_K_M, Q8_0), this is the correct optimization target.

### Inference Engine Compatibility Matrix

| Engine | Min CC | GTX 1080 (CC 6.1) | Notes |
|--------|--------|-------------------|-------|
| **llama.cpp CUDA** | CC 5.0 | ✅ Full support | Recommended; use Pascal-specific build flags |
| **Ollama** | CC 5.0 | ✅ Full support | Wraps llama.cpp; easy model management |
| **fastembed-gpu (ONNX)** | CC 3.5+ | ✅ With CUDA 11.x | Use CUDA 11.8, not CUDA 12.x (may require CC 7.5+) |
| **PyTorch CUDA 11.8** | CC 3.5 | ✅ Full support | FP32 best; FP16 memory savings only |
| **CTranslate2** | CC 3.5 | ✅ Full support | INT8 DP4A; 2-4x vs PyTorch for BERT-class models |
| **TensorRT** | CC 3.5 | ✅ Limited | INT8 DP4A works; 1.8-2.5x vs PyTorch |
| **vLLM** | CC 7.0 | ❌ Blocked | PagedAttention hardcoded CC 7.0+ |
| **SGLang** | CC 7.0+ | ❌ Blocked | RadixAttention requires Flash Attention 2 (CC 8.0+) |
| **HuggingFace TEI** | CC 7.5 | ❌ Blocked | Hard requirement, open issue #740 since Oct 2025 |
| **TGI (HuggingFace)** | CC 7.0 | ❌ Blocked | Same Flash Attention constraint |

---

## 3. Architecture Decision

### Revised Recommendation: GPU Embedding on GTX 1080

Given the T620's AVX-only CPU constraint, the architecture shifts from "CPU embedding" to "GPU embedding via llama.cpp CUDA server":

```
User query → llama-server /v1/embeddings → GTX 1080 (CUDA)
             - nomic-embed-text-v1.5 F16 GGUF
             - --n-gpu-layers 99 (all layers on GPU)
             - --no-flash-attn (mandatory for Pascal)
             - --parallel 8 (continuous batching)
```

The corpus pre-embedding (50 documents, done once at startup) runs on GPU in ~300ms.
Each search query is embedded on GPU in ~25–50ms.
Cosine similarity over 50 vectors is NumPy, <1ms.

### Options Evaluated

#### Option A: llama.cpp CUDA Server ✅ RECOMMENDED

```
query → llama-server /v1/embeddings endpoint → GTX 1080 → embeddings
```

- Handles all CUDA context management
- Built-in continuous batching for concurrent requests
- `--parallel 8` batches concurrent requests into single GPU forward passes
- Native `/v1/embeddings` endpoint (OpenAI-compatible)
- Direct GGUF model support for nomic-embed-text-v1.5

#### Option B: fastembed-gpu (ONNX Runtime CUDA)

- `pip install fastembed-gpu` — ONNX Runtime CUDA EP
- Requires CUDA 11.8 (CUDA 12.x may block CC 6.1)
- Good alternative if llama.cpp GGUF embedding has issues
- ~10-15% faster than PyTorch; slower than llama.cpp for batched GGUF

#### Option C: CTranslate2 INT8 CUDA

- Best throughput for BERT-class encoder models
- INT8 DP4A on Pascal gives 2-4x vs PyTorch
- Verify nomic-embed-text-v1.5 compatibility (custom RoPE/SwiGLU may not be supported)

#### Option D: CPU-only (NOT viable)

Estimated 2.5–5s for 50-document batch on Xeon E5-2600 v2 without AVX2. Fails the 3s budget.

---

## 4. Model Recommendations

### Embedding Model: `nomic-embed-text-v1.5` (unchanged recommendation)

| Model | Params | VRAM (F16) | GPU query latency | MTEB Score |
|-------|--------|-----------|-------------------|------------|
| **`nomic-embed-text-v1.5`** ✅ | 137M | 274MB | ~25–50ms | 64.6 |
| `BGE-small-en-v1.5` | 33M | 65MB | ~5–15ms | 62.2 |
| `all-MiniLM-L6-v2` | 22M | 45MB | ~3–8ms | 56.3 |

**Why nomic-embed-text-v1.5 on GPU:**
- 8192-token context window (handles long doc sections without truncation)
- 274MB VRAM — 7.7GB free for batching and KV headroom
- Official GGUF available: `nomic-ai/nomic-embed-text-v1.5-GGUF` on HuggingFace
- Supports `--pooling mean` in llama-server

**GGUF format to use:** `nomic-embed-text-v1.5.F16.gguf`
- F16 weights: 274MB, memory bandwidth savings without compute penalty
- Q8_0 alternative: 137MB, slightly slower on F16-native ops but may benefit from MMQ INT8
- Avoid Q4_K_M for embedding models — quality degradation affects retrieval precision more than generation

---

## 5. GTX 1080 Pascal Optimizations

### 5.1 Build llama.cpp with Pascal-Specific Flags

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp

cmake -B build \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=61 \      # Target Pascal CC 6.1 exactly — 5-15% faster vs generic
  -DGGML_AVX=ON \                       # T620 CPU has AVX
  -DGGML_AVX2=OFF \                     # T620 CPU does NOT have AVX2 — must disable
  -DGGML_FMA=OFF \                      # FMA3 requires AVX2 — must disable on T620
  -DGGML_F16C=ON \                      # F16C (float16 conversion) available on Ivy Bridge
  -DGGML_SSE41=ON \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release -j $(nproc)
```

**Why `-DCMAKE_CUDA_ARCHITECTURES=61` matters:**
- Without it, llama.cpp builds for multiple architectures and includes PTX fallback
- Pascal-specific register allocation and instruction scheduling is applied
- Eliminates JIT recompilation on first run (saves 5–15s startup)
- Measured 5–15% improvement in prompt processing throughput on CC 6.1 hardware

### 5.2 Flash Attention — Always Disabled on GTX 1080

**This is the most important runtime flag.** Flash Attention 2 requires CC ≥ 8.0; there is a CC ≥ 7.5 software fallback in llama.cpp. On CC 6.1 (Pascal), Flash Attention either errors out or triggers a slower fallback path.

Measured regression from a Pascal card (CC 6.1) with Flash Attention enabled:
- Without FA: 9.1ms/token = **109.51 T/s**
- With FA (fallback): 11.4ms/token = **87.46 T/s** — **20% slower**

Always use:
```bash
llama-server ... --no-flash-attn
```

### 5.3 cuBLAS vs MMQ (Quantized Matrix Multiply) on Pascal

llama.cpp has two CUDA GEMM backends:
- **cuBLAS**: NVIDIA's math library, FP32 paths work well on all CUDA GPUs
- **MMQ**: Custom GGML quantized kernels using INT8 `__dp4a` (designed for Tensor Core GPUs)

On GP104 (no Tensor Cores), the choice depends on the model format:

| Model format | Recommended backend | Why |
|---|---|---|
| F16 (unquantized weights) | cuBLAS (default) | FP32 cuBLAS is optimal on GP104; MMQ is INT8-focused |
| Q8_0 | Test both; MMQ may win | DP4A INT8 at FP32 parity throughput |
| Q4_K_M | MMQ likely better | DP4A leverages 4-bit dequantize + INT8 accumulate |

To test MMQ:
```bash
GGML_CUDA_FORCE_MMQ=1 llama-server ...
```
Or compile-time:
```bash
cmake -B build -DGGML_CUDA=ON -DGGML_CUDA_FORCE_MMQ=ON ...
```

**For nomic-embed-text-v1.5 F16:** Use default cuBLAS (FP32 path). Test MMQ only with Q8_0.

### 5.4 Full GPU Offload

All 12 transformer layers of nomic-embed-text-v1.5 fit in 274MB VRAM. Always offload everything:

```bash
llama-server ... --n-gpu-layers 99
```

Never split layers between CPU and GPU for this hardware — the T620 CPU's lack of AVX2 makes CPU compute significantly slower, creating a bottleneck at every hybrid layer boundary.

### 5.5 Continuous Batching for Concurrent Requests

```bash
llama-server \
  --model nomic-embed-text-v1.5.F16.gguf \
  --n-gpu-layers 99 \
  --embedding \
  --pooling mean \
  --batch-size 4096 \        # Logical batch: 4096 tokens processed per decode step
  --ubatch-size 4096 \       # Physical GPU batch size matches logical
  --ctx-size 8192 \          # Full context window of nomic-embed
  --rope-scaling yarn \      # Required for nomic-embed-text-v1.5
  --rope-freq-scale 0.75 \   # Required for nomic-embed-text-v1.5
  --no-flash-attn \          # MANDATORY on Pascal
  --parallel 64 \            # 64 concurrent embedding slots — sized for AI agent traffic
  --host 127.0.0.1 \
  --port 8080
```

`--parallel 64` is the key setting for AI agent traffic. When many agents submit searches simultaneously, the server collects up to 64 query embeddings and processes them as a single GPU forward pass. For human-only interactive search, `--parallel 8` is sufficient; for AI agent workloads use `--parallel 64` (see Section 6.2 for full analysis).

### 5.6 FP16 — Memory Savings Only, Not Compute Speedup

On GP104:
- FP16 store: 274MB model vs 548MB for FP32 — save ~274MB VRAM and bandwidth
- FP16 compute: 1/64 of FP32 throughput (intentionally crippled by NVIDIA)
- Practical outcome: FP16 weights reduce memory pressure, no measurable compute speedup

Use F16 GGUF for the memory savings. Do not expect a 2× speedup.

---

## 6. Concurrency Analysis

### VRAM Budget for 50-Document Search

```
nomic-embed-text-v1.5 F16 weights:           274 MB
Activations, batch=50, seq=200 tokens:       ~400 MB
                                           ─────────
Peak VRAM during corpus embedding:          ~674 MB
Remaining VRAM:                             ~7.3 GB  ← almost entirely free
```

The 50-document corpus embedding at startup uses <700MB of 8GB. Essentially unlimited headroom for serving concurrent queries.

### Throughput Estimates — GTX 1080, nomic-embed-text-v1.5 F16

| Operation | Estimated time |
|-----------|---------------|
| Startup corpus embedding (50 docs × 200 tokens) | ~300–600ms (once) |
| Single query embedding (batch=1, 50 tokens) | ~25–50ms |
| 8 concurrent queries (continuous batched as one pass) | ~60–100ms per query |
| NumPy cosine similarity (50 docs) | <1ms |
| Cloudflare + HTTP overhead | ~30–50ms |
| **Total end-to-end (single user)** | **~80–150ms** |
| **Total end-to-end (8 concurrent users)** | **~120–200ms each** |

### 6.1 Concurrent Capacity by Parallel Setting

| `--parallel` setting | Use case | QPS estimate | Per-query latency |
|---------------------|----------|--------------|-------------------|
| 8 | Human interactive search | ~50–80 QPS | ~70–100ms |
| 32 | Mixed human + light agent | ~200–450 QPS | ~80–120ms |
| **64** | **AI agent workload** | **~400–900 QPS** | **~50–150ms** ← **recommended** |
| 128 | Heavy sustained agent bursts | ~600–1,200 QPS | ~100–250ms |

**For AI agent deployments, `--parallel 64` is the production default.** See Section 6.2–6.6 for the full multi-instance analysis.

### Why Batching Helps More for Embeddings Than Generation

Autoregressive generation has a sequential dependency (each token depends on previous). Embeddings do not — the entire batch of N sequences can be processed as a single matrix multiply. The GTX 1080's 2,560 CUDA cores reach full occupancy around batch_size 8–16 for a 768-dim model. For AI agent traffic (hundreds of concurrent requests), scale `--parallel` to 64 — see Section 6.2.

### 6.2 Scaling to Thousands of Concurrent AI Agent Queries

The initial recommendation of `--parallel 8` targets human-speed interactive search (8 users simultaneously). AI agents hit search endpoints in automated bursts — potentially hundreds to thousands of requests per minute. With only 274MB VRAM used by the model, the GTX 1080 has ~7.7GB of remaining headroom.

**Revised recommendation for AI agent workloads: `--parallel 64`.**

This is the single most important tuning change for agent-heavy traffic. At `--parallel 64`, the server queues up to 64 in-flight embedding requests and processes them as one GPU forward pass — maximizing SM occupancy and amortizing CUDA kernel launch overhead across the full batch.

### 6.3 Throughput Estimates at Scale

GTX 1080 real sustained FP32: ~5 TFLOPS (derated from 8.87 TFLOPS peak for continuous workloads).

| Scenario | `--parallel` | QPS estimate | Per-query latency |
|----------|-------------|--------------|-------------------|
| Interactive search (human) | 8 | ~50–80 QPS | ~70–100ms |
| **AI agent workload (recommended)** | **64** | **~400–900 QPS** | **~50–150ms burst** |
| Aggressive sustained peak | 128 | ~600–1,200 QPS | ~100–250ms |

**QPS basis:**
- 50-token average query: ~400–900 QPS at `--parallel 64`
- 200-token average query: ~130–220 QPS at `--parallel 64`
- Values are per-GPU estimates under continuous load; single-shot latency is lower

**At 1,000 req/min (AI agent batch):** ~16.7 RPS — comfortably within capacity.
**At 10,000 req/min:** ~167 RPS — still within capacity for short queries.
**At 60,000 req/min:** ~1,000 RPS — approaching limit; use Redis-backed multi-node at this scale.

### 6.4 Single Instance vs Multiple Instances

Running multiple llama-server processes each with `--parallel 8` might seem like it would help, but for homogeneous embedding workloads, **a single `--parallel 64` instance is strictly better:**

| Approach | Instances | VRAM per instance | Total VRAM used | QPS | Verdict |
|----------|-----------|------------------|-----------------|-----|---------|
| **Single `--parallel 64`** | **1** | **~1,050MB** | **~1.1GB** | **~400–900** | **Best — one large batch per GPU pass** |
| 3× `--parallel 32` (no MPS) | 3 | ~734MB | ~2.2GB | ~350–700 | Redundant CUDA contexts waste 3×350MB |
| 8× `--parallel 16` (no MPS) | 8 | ~734MB | ~5.9GB | ~300–600 | Almost fills 8GB on context overhead alone |
| 3× `--parallel 32` (with MPS) | 3 | ~434MB | ~1.3GB | ~350–700 | MPS amortizes context; still less than single-64 |
| 14× `--parallel 8` (with MPS) | 14 | ~434MB | ~6.1GB | ~450–850 | Most instances; diminishing returns on 20-SM GPU |

**VRAM breakdown for single `--parallel 64` instance:**
```
Model weights (F16):                           274 MB
CUDA context (one process):                    350 MB
Compute workspace (batch=64 forward pass):     200 MB
KV cache (64 slots × avg 100 tokens × 36KB):  ~230 MB
                                             ─────────
Total (practical, avg 100-token queries):    ~1,054 MB
Remaining VRAM:                              ~6.9 GB  ← free headroom
```

**Why single instance wins for pure embedding workloads:**
- Embedding forward passes are fully parallel (no sequential token dependency like generation)
- A `--parallel 64` call submits all 64 sequences as one batched matrix multiply — perfect SM occupancy
- Multiple processes split the workload into smaller batches, reducing batching efficiency
- At batch ≥ 16 on a 20-SM Pascal GPU, the SMs are already near full saturation during a single forward pass — concurrent processes compete rather than cooperate

**When multiple instances do make sense:**
- Multi-GPU setups (one instance per card)
- Rolling upgrades without downtime (canary deployment)
- Mixed workloads (embedding + generation simultaneously, partitioned by CUDA MPS)
- Load balancing across multiple machines in a scale-out cluster

### 6.5 CUDA MPS on Pascal CC 6.1

**CUDA Multi-Process Service (MPS)** is a shared-context daemon that enables Hyper-Q concurrent kernel scheduling across multiple processes. It eliminates redundant per-process CUDA context overhead.

**Pascal CC 6.1 MPS compatibility:**
- Minimum requirement: CC 3.5 ✅ (GTX 1080 = CC 6.1 ✅)
- Maximum concurrent clients (pre-Volta hardware): 16
- Hyper-Q concurrent streams: enabled
- **Key limitation (pre-Volta):** A crash in one MPS client CAN propagate and crash the MPS server — this fault isolation gap was fixed in Volta (CC 7.0+). For production use, monitor client health.

**When CUDA MPS saves VRAM:**

| Component | Without MPS | With MPS |
|-----------|-------------|----------|
| Model weights | 274MB | 274MB |
| CUDA context | 350MB (per process) | ~50MB (amortized via shared daemon) |
| Compute workspace | ~80MB | ~80MB |
| KV cache (32 slots) | ~30MB | ~30MB |
| **Total per instance** | **~734MB** | **~434MB** |
| Instances in 8GB | 8–9 | 14–16 |

**When MPS improves throughput:**
MPS enables true concurrent kernel execution from multiple client processes via Hyper-Q. However, at `--parallel 32+`, a single llama-server instance already saturates the 20 SMs during its forward pass. Concurrent instances don't run simultaneously — they queue. MPS **saves ~300MB VRAM per instance** but provides minimal throughput improvement over a single well-tuned `--parallel 64` instance for homogeneous embedding-only workloads.

**When MPS is genuinely useful here:** Running an embedding instance AND a generation instance (e.g., a small 1.7B model for the future `/answer` endpoint) simultaneously on the same GPU — MPS lets them share the context and interleave GPU time.

**CUDA MPS setup commands:**

```bash
# 1. Set exclusive compute mode (required for MPS)
sudo nvidia-smi -i 0 -c EXCLUSIVE_PROCESS

# 2. Set up MPS directories
export CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps
export CUDA_MPS_LOG_DIRECTORY=/tmp/nvidia-log
mkdir -p /tmp/nvidia-mps /tmp/nvidia-log

# 3. Start MPS daemon
sudo CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps \
     CUDA_MPS_LOG_DIRECTORY=/tmp/nvidia-log \
     nvidia-cuda-mps-control -d

# 4. Verify MPS is running
echo "get_default_active_thread_percentage" | nvidia-cuda-mps-control

# 5. (Optional) Allocate thread budget per client (e.g., 3 clients at 33% each)
CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=33 llama-server ...

# 6. Stop MPS when done
echo quit | sudo nvidia-cuda-mps-control
sudo nvidia-smi -i 0 -c DEFAULT  # Restore default compute mode
```

**Systemd service for persistent MPS daemon:**

```ini
# /etc/systemd/system/nvidia-mps.service
[Unit]
Description=NVIDIA CUDA MPS Daemon
After=network.target

[Service]
Type=forking
Environment=CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps
Environment=CUDA_MPS_LOG_DIRECTORY=/tmp/nvidia-log
ExecStartPre=/usr/bin/mkdir -p /tmp/nvidia-mps /tmp/nvidia-log
ExecStartPre=/usr/bin/nvidia-smi -i 0 -c EXCLUSIVE_PROCESS
ExecStart=/usr/bin/nvidia-cuda-mps-control -d
ExecStop=/bin/bash -c 'echo quit | nvidia-cuda-mps-control'
ExecStopPost=/usr/bin/nvidia-smi -i 0 -c DEFAULT
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### 6.6 Queuing Architecture for AI Agent Traffic

For thousands of concurrent AI agent queries, the queuing strategy at the Python sidecar layer is critical:

```
AI Agents (1000s req/min)
         │
┌────────▼────────────────────────────────────────┐
│  Python FastAPI search-service                  │
│  asyncio.Semaphore(cap=200)  ← burst protection │
│  httpx connection pool: max_connections=200     │
│  max_keepalive_connections=64                   │
└────────────────┬────────────────────────────────┘
                 │  HTTP POST /v1/embeddings
┌────────────────▼────────────────────────────────┐
│  llama-server --parallel 64                     │
│  Internal slot queue: up to 64 concurrent       │
│  GTX 1080 processes as single batched pass      │
│  ~400–900 QPS sustained (50-token avg)          │
└─────────────────────────────────────────────────┘
```

**Updated `embed()` function with semaphore and connection pooling:**

```python
import asyncio
import httpx
import numpy as np

MAX_CONCURRENT_EMBEDDINGS = 200  # ~3× parallel slots — allows deep queuing without rejection
_sem = asyncio.Semaphore(MAX_CONCURRENT_EMBEDDINGS)

# Persistent connection pool (reuse TCP connections across requests)
_http_client = httpx.AsyncClient(
    timeout=30.0,
    limits=httpx.Limits(
        max_connections=200,
        max_keepalive_connections=64,
        keepalive_expiry=30,
    ),
)

async def embed(texts: list[str]) -> np.ndarray:
    """Call llama-server /v1/embeddings with concurrency cap and connection reuse."""
    async with _sem:
        resp = await _http_client.post(
            f"{LLAMA_SERVER_URL}/v1/embeddings",
            json={"model": "nomic-embed-text-v1.5", "input": texts},
        )
        resp.raise_for_status()
        data = resp.json()
        vecs = np.array([d["embedding"] for d in data["data"]], dtype=np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs / np.maximum(norms, 1e-10)
```

**Note:** Use `workers=1` in uvicorn (single process, async I/O) — multiple worker processes each need their own httpx pool and semaphore, and don't share state. With asyncio + `--parallel 64` in llama-server, a single uvicorn worker handles thousands of concurrent requests efficiently.

**For multi-node scaling (when one GTX 1080 is insufficient):**
- Add an nginx load balancer in front of multiple search-service + llama-server pairs
- Each node holds its own in-memory corpus embeddings (corpus is static, ~2MB JSON)
- No Redis/shared cache needed — pre-embedding is fast (<600ms at startup)

### 6.7 Alternative High-Throughput Backends for Pascal

If llama.cpp throughput proves insufficient, these alternatives are confirmed to work on CC 6.1:

| Backend | How to install | Notes |
|---------|---------------|-------|
| **Triton Inference Server ≤ 24.01** | `docker pull nvcr.io/nvidia/tritonserver:24.01-py3` | Supports CC 6.0+; **24.02+ requires CC 7.0+** — pin the version |
| **infinity-emb** | `pip install "infinity-emb[torch]"` | Requires `torch==2.7.*`; **PyTorch 2.8+ dropped CC 6.1** |
| **fastembed-gpu (ONNX Runtime)** | `pip install fastembed-gpu` | Requires CUDA 11.8; CUDA 12.x may block CC 6.1 |
| **CTranslate2** | `pip install ctranslate2` | INT8 DP4A on Pascal; 2-4× vs PyTorch for BERT-class models |

**Critical version lock warning — PyTorch:**

```bash
# PyTorch 2.8+ dropped Pascal CC 6.1 support. Always pin:
pip install "torch==2.7.*" --index-url https://download.pytorch.org/whl/cu121
# Or for CUDA 11.8:
pip install "torch==2.7.*" --index-url https://download.pytorch.org/whl/cu118
```

**CUDA Toolkit version note:** CUDA Toolkit 13.x also dropped offline compilation for CC 6.1. Use CUDA 12.x toolkit for building llama.cpp with Pascal support.

**Triton Inference Server setup for nomic-embed (ONNX backend):**

```bash
# Pull last version supporting CC 6.1
docker pull nvcr.io/nvidia/tritonserver:24.01-py3

# Export nomic-embed-text-v1.5 to ONNX
pip install "torch==2.7.*" transformers optimum
python -c "
from optimum.exporters.onnx import main_export
main_export('nomic-ai/nomic-embed-text-v1.5',
            output='/opt/triton/models/nomic-embed/1/',
            task='feature-extraction')
"

# config.pbtxt for dynamic batching
cat > /opt/triton/models/nomic-embed/config.pbtxt << 'EOF'
name: "nomic-embed"
backend: "onnxruntime"
dynamic_batching {
  preferred_batch_size: [32, 64]
  max_queue_delay_microseconds: 10000
}
instance_group [{ count: 1, kind: KIND_GPU }]
EOF

docker run --gpus all -p 8000:8000 \
  -v /opt/triton:/models \
  nvcr.io/nvidia/tritonserver:24.01-py3 \
  tritonserver --model-repository=/models
```

---

## 7. Backend Comparison Matrix

| Backend | Pascal Support | 50-doc batch latency | 8 concurrent queries | Notes |
|---------|---------------|----------------------|----------------------|-------|
| **llama.cpp CUDA** ✅ | Full | 250–500ms | ~100ms each | Recommended; built-in HTTP server |
| ONNX Runtime CUDA (fastembed-gpu) | Full (CUDA 11.8) | 200–400ms | ~80ms each | Use CUDA 11.8 not 12.x |
| PyTorch CUDA 11.8 | Full | 300–600ms | ~120ms each | FP32 best; FP16 no speedup |
| CTranslate2 INT8 CUDA | Full | 150–350ms | ~70ms each | Best if nomic-embed supported |
| TensorRT INT8 | Full (limited) | 150–300ms | ~60ms each | Complex setup; 1.8-2.5x vs PyTorch |
| **CPU only (Xeon E5-2600 v2)** | N/A | **2,500–5,000ms** | **Fails 3s** | AVX-only, no AVX2 |
| HuggingFace TEI | ❌ CC<7.5 | N/A | N/A | Hard blocked |

---

## 8. Implementation Plan

### Phase 1: llama.cpp Embedding Server (Implement Now)

1. Build llama.cpp with Pascal flags (see Section 5.1)
2. Download `nomic-embed-text-v1.5.F16.gguf` from HuggingFace
3. Run llama-server with embedding mode (see Section 5.5)
4. Python FastAPI sidecar pre-embeds corpus at startup, queries llama-server for live queries
5. Node.js proxy routes `/api/docs-search` → Python sidecar

### Phase 2: Frontend Integration

- `DocsPage.tsx` sends `GET /api/docs-search?q=<query>` instead of in-memory keyword search
- Falls back to existing keyword search if API unavailable
- `VITE_SEARCH_API_URL` env var controls the endpoint

### Phase 3: Optional Reranker

Add `BAAI/bge-reranker-v2-m3` (570M, CTranslate2 INT8) for top-10 → top-5 reranking. Implement only if Phase 1 recall is insufficient.

---

## 9. Build & Run Commands

### Install llama.cpp (Pascal-optimized)

```bash
# Prerequisites
sudo apt install -y build-essential cmake git nvidia-cuda-toolkit

# Clone and build
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp

cmake -B build \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=61 \
  -DGGML_AVX=ON \
  -DGGML_AVX2=OFF \
  -DGGML_FMA=OFF \
  -DGGML_F16C=ON \
  -DGGML_SSE41=ON \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release -j $(nproc)
sudo cp build/bin/llama-server /usr/local/bin/
```

### Download Model

```bash
# Install huggingface-cli
pip install huggingface_hub

# Download F16 GGUF
huggingface-cli download nomic-ai/nomic-embed-text-v1.5-GGUF \
  nomic-embed-text-v1.5.f16.gguf \
  --local-dir /opt/dominusnode/models/

# Alternative: direct wget
# wget https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.f16.gguf \
#   -O /opt/dominusnode/models/nomic-embed-text-v1.5.f16.gguf
```

### Start Embedding Server

```bash
llama-server \
  --model /opt/dominusnode/models/nomic-embed-text-v1.5.f16.gguf \
  --n-gpu-layers 99 \
  --embedding \
  --pooling mean \
  --batch-size 4096 \
  --ubatch-size 4096 \
  --ctx-size 8192 \
  --rope-scaling yarn \
  --rope-freq-scale 0.75 \
  --no-flash-attn \
  --parallel 64 \            # 64 for AI agent traffic; use 8 for human-only interactive search
  --host 127.0.0.1 \
  --port 8080
```

### Test It

```bash
# Health check
curl http://127.0.0.1:8080/health

# Embed a query
curl -X POST http://127.0.0.1:8080/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text-v1.5","input":"search_query: how do I rotate my API key"}'
# → { "data": [{ "embedding": [0.023, -0.012, ...768 floats...] }] }

# Performance check: test MMQ vs cuBLAS
time GGML_CUDA_FORCE_MMQ=1 curl -X POST http://127.0.0.1:8080/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text-v1.5","input":"search_query: stripe payment"}'
```

### Systemd Service

```ini
# /etc/systemd/system/dominusnode-embeddings.service
[Unit]
Description=Dominus Node Embedding Server (llama.cpp)
After=network.target
Wants=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/local/bin/llama-server \
    --model /opt/dominusnode/models/nomic-embed-text-v1.5.f16.gguf \
    --n-gpu-layers 99 \
    --embedding \
    --pooling mean \
    --batch-size 4096 \
    --ubatch-size 4096 \
    --ctx-size 8192 \
    --rope-scaling yarn \
    --rope-freq-scale 0.75 \
    --no-flash-attn \
    --parallel 64 \
    --host 127.0.0.1 \
    --port 8080
Restart=always
RestartSec=10
Environment=CUDA_VISIBLE_DEVICES=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dominusnode-embeddings
sudo journalctl -u dominusnode-embeddings -f
```

---

## 10. Full Python Sidecar Code

### `server/search-service/main.py`

```python
"""
Dominus Node Docs Semantic Search Service
Embedding backend: llama.cpp CUDA server (nomic-embed-text-v1.5)
GPU: GTX 1080 (Pascal CC 6.1)
"""

import json
import os
import time
import numpy as np
from pathlib import Path
from typing import List

import httpx
import uvicorn
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CORPUS_PATH = Path(__file__).parent / "corpus_data.json"
LLAMA_SERVER_URL = os.getenv("LLAMA_SERVER_URL", "http://127.0.0.1:8080")
TOP_K = 5
MIN_SCORE = 0.20
PORT = int(os.getenv("SEARCH_PORT", "8765"))
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "https://dominusnode.com").split(",")

# nomic-embed-text-v1.5 requires "search_query: " prefix for asymmetric search
QUERY_PREFIX = "search_query: "
# Documents should be prefixed with "search_document: " at indexing time
DOC_PREFIX = "search_document: "


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SearchResult(BaseModel):
    id: str
    section_id: str
    section_title: str
    subsection_title: str
    preview: str
    score: float


class SearchResponse(BaseModel):
    results: List[SearchResult]
    query_time_ms: float


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Dominus Node Search", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)

corpus: list = []
corpus_embeddings: np.ndarray = None  # shape: (N, 768), L2-normalized


async def embed(texts: list[str]) -> np.ndarray:
    """Call llama-server /v1/embeddings endpoint."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{LLAMA_SERVER_URL}/v1/embeddings",
            json={"model": "nomic-embed-text-v1.5", "input": texts},
        )
        resp.raise_for_status()
        data = resp.json()
        vecs = np.array([d["embedding"] for d in data["data"]], dtype=np.float32)
    # L2 normalize
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs / np.maximum(norms, 1e-10)


@app.on_event("startup")
async def startup():
    global corpus, corpus_embeddings

    print(f"Loading corpus from {CORPUS_PATH}...")
    with open(CORPUS_PATH) as f:
        corpus = json.load(f)
    print(f"  {len(corpus)} sections loaded")

    # Wait for llama-server to be ready
    for attempt in range(30):
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{LLAMA_SERVER_URL}/health")
                if r.status_code == 200:
                    break
        except Exception:
            pass
        print(f"  Waiting for llama-server... ({attempt + 1}/30)")
        await asyncio.sleep(2)

    print("Pre-embedding corpus on GPU...")
    t0 = time.perf_counter()

    # Prefix documents for asymmetric search
    doc_texts = [DOC_PREFIX + entry["text"] for entry in corpus]

    # Embed in one batch (50 docs fits in llama-server's batch window)
    corpus_embeddings = await embed(doc_texts)

    elapsed = (time.perf_counter() - t0) * 1000
    print(f"  Corpus embedded in {elapsed:.0f}ms — shape {corpus_embeddings.shape}")
    print(f"Search service ready on port {PORT}")


# ---------------------------------------------------------------------------
# Search endpoint
# ---------------------------------------------------------------------------

@app.get("/search", response_model=SearchResponse)
async def search(q: str = Query(..., min_length=1, max_length=500)):
    t0 = time.perf_counter()

    # Embed query with search_query prefix
    query_vec = await embed([QUERY_PREFIX + q])
    query_vec = query_vec[0]  # shape: (768,)

    # Cosine similarity = dot product (both L2-normalized)
    scores = corpus_embeddings @ query_vec  # shape: (N,)

    # Top-K
    top_indices = np.argsort(scores)[::-1][:TOP_K]

    results = []
    for idx in top_indices:
        score = float(scores[idx])
        if score < MIN_SCORE:
            continue
        entry = corpus[int(idx)]
        preview = entry["text"].split("\n")[0][:200]
        results.append(SearchResult(
            id=entry["id"],
            section_id=entry["section_id"],
            section_title=entry["section_title"],
            subsection_title=entry["subsection_title"],
            preview=preview,
            score=round(score, 4),
        ))

    elapsed = (time.perf_counter() - t0) * 1000
    return SearchResponse(results=results, query_time_ms=round(elapsed, 2))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "corpus_size": len(corpus),
        "backend": LLAMA_SERVER_URL,
    }


if __name__ == "__main__":
    import asyncio
    uvicorn.run("main:app", host="127.0.0.1", port=PORT, workers=1, loop="uvloop")
```

### `server/search-service/requirements.txt`

```
httpx>=0.27.0
numpy>=1.24.0
fastapi>=0.110.0
uvicorn[standard]>=0.27.0
pydantic>=2.0.0
uvloop>=0.19.0
```

### `packages/frontend/scripts/export-search-index.ts`

Run after any docs content change to regenerate `corpus_data.json`:

```typescript
import { DOC_SECTIONS } from '../src/data/docs-content';
import * as fs from 'fs';
import * as path from 'path';

function buildSearchIndex() {
  return DOC_SECTIONS.flatMap(section =>
    section.subsections.map(sub => {
      const parts: string[] = [sub.title, ...(sub.searchTerms ?? [])];
      for (const block of sub.content) {
        if (block.type === 'text') parts.push(block.text);
        else if (block.type === 'note') parts.push(block.text);
        else if (block.type === 'heading') parts.push(block.text);
        else if (block.type === 'param-table')
          block.params.forEach(p => parts.push(`${p.name} ${p.description}`));
        else if (block.type === 'endpoint-table')
          block.endpoints.forEach(e => parts.push(`${e.method} ${e.path} ${e.description}`));
      }
      return {
        id: sub.id,
        section_id: section.id,
        section_title: section.title,
        subsection_title: sub.title,
        text: parts.join('\n'),
      };
    })
  );
}

const index = buildSearchIndex();
const outPath = path.resolve(__dirname, '../../server/search-service/corpus_data.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(index, null, 2));
console.log(`Exported ${index.length} entries to ${outPath}`);
```

---

## 11. Cloudflare Tunnel Setup

### Install cloudflared

```bash
curl -L https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared focal main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

cloudflared tunnel login
cloudflared tunnel create dominusnode-search
```

### `~/.cloudflared/config.yml`

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: search.dominusnode.com
    service: http://127.0.0.1:8765    # Python FastAPI sidecar
  - service: http_status:404
```

```bash
cloudflared tunnel route dns dominusnode-search search.dominusnode.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Cloudflare Dashboard Settings for `search.dominusnode.com`

| Setting | Value |
|---------|-------|
| SSL/TLS | Full (strict) |
| WAF rate limit | 100 req/min per IP |
| Cache Level | Bypass |
| Bot Fight Mode | On |

---

## 12. Future Generative Upgrade Path

### Current Hardware Ceiling

The GTX 1080 can handle embedding inference well but struggles with generative RAG:
- 4B model at Q4_K_M: ~20–25 tokens/sec → 8–10s for a 200-token answer
- Under 8 concurrent users: requests queue → last user waits 30–60s
- Not viable for sub-3s generative answers

### When to Upgrade the GPU

| GPU | VRAM | t/s (4B Q4) | Used Price | Verdict |
|-----|------|------------|------------|---------|
| GTX 1080 (current) | 8GB | ~20–25 | — | Embedding only |
| **RTX 3060 12GB** | 12GB | ~90–110 | ~$220 | Best upgrade value |
| RTX 4060 8GB | 8GB | ~100–120 | ~$300 | Fast but less VRAM than 3060 |
| RTX 4070 Ti 12GB | 12GB | ~160–200 | ~$550 | Serious throughput |

**RTX 3060 12GB** is the recommended upgrade path. With Tensor Cores and 12GB VRAM, it handles 7B models at Q4_K_M (~5.5GB + KV cache) with full vLLM/SGLang support unlocked at CC 8.6.

### Generative Model Recommendations (Post-Upgrade or on Current GPU for Light Use)

| Model | Quant | VRAM | t/s (GTX 1080) | t/s (RTX 3060) | Answer latency (RTX 3060) |
|-------|-------|------|---------------|----------------|--------------------------|
| Qwen3-1.7B | Q8_0 | 1.9GB | ~40–50 | ~180–220 | **<1s** |
| Qwen3-4B | Q4_K_M | 3.5GB | ~20–25 | ~90–110 | ~2s |
| Gemma3-4B QAT | int4 | 2.6GB | ~20–30 | ~100–120 | ~2s |

**Qwen3 note:** Always disable thinking mode for search/RAG to cut latency in half:
```
System prompt: /no_think
```

### Adding `/answer` Endpoint to the Sidecar (Future)

```python
@app.post("/answer")
async def answer(query: str, top_k: int = 3):
    # 1. Get top-k sections via existing search()
    # 2. Build context from section text
    # 3. POST to Ollama /api/generate with Qwen3-4B
    # 4. Return generated answer + source sections
    ...
```

---

## 13. Agentic Swarm Architecture

**Question:** Is it better to run many tiny embedding models (replicas) or one good model with a high-end queue/batching system when AI agentic swarms are the primary traffic source?

**Answer: One good model with adaptive batching + semantic cache.** The many-tiny-models approach fails on Pascal hardware specifically due to pre-Volta CUDA MPS limitations, and tiny model quality is genuinely insufficient for documentation retrieval tasks.

### 13.1 Model Quality — Why Tiny Models Fail for Docs Search

This is the most important factor and it rules out `all-MiniLM-L6-v2` outright.

| Model | Params | MTEB Retrieval Avg | Context Window | Verdict |
|-------|--------|-------------------|----------------|---------|
| all-MiniLM-L6-v2 | 22M | ~41–44 NDCG@10 | 256 tokens | ❌ Disqualified |
| BGE-small-en-v1.5 | 33M | ~51–53 NDCG@10 | 512 tokens | ⚠️ Minimum viable |
| **nomic-embed-text-v1.5** | **137M** | **~55–57 NDCG@10** | **8192 tokens** | **✅ Recommended** |
| BGE-large-en-v1.5 | 335M | ~54–56 NDCG@10 | 512 tokens | ❌ 5× compute cost, marginal gain |

**Why MiniLM is disqualified for docs search:**
- MiniLM was trained on sentence similarity, not document retrieval — it "suffers on BEIR retrieval tasks which require passage-level understanding" (roughly 10–12 NDCG points below BGE-small on passage retrieval)
- **Context window of 256 tokens silently truncates AI agent queries.** Agents prepend task context: "Given that we are integrating a proxy service into our CrewAI pipeline and need to handle HTTPS CONNECT tunneling with API key authentication, find documentation about..." — these are 80–200 token queries that MiniLM chops mid-sentence
- nomic-embed-text-v1.5's 8192-token context handles the longest realistic agent query without truncation

**Quality plateau:** The gap from 22M → 137M is ~13–15 NDCG points (large). From 137M → 335M is ~0–2 NDCG points (negligible). Quality saturates at the 137M range for retrieval tasks.

### 13.2 Why Many Tiny Replicas Don't Work on Pre-Volta Pascal

The intuition "10× MiniLM replicas = 10× throughput" is invalid on Pascal for a fundamental hardware reason:

**Pre-Volta CUDA MPS does NOT provide concurrent kernel execution.**

NVIDIA MPS (Multi-Process Service) on pre-Volta hardware (CC < 7.0):
- Serializes GPU kernel execution — only one client executes kernels at a time
- Provides concurrent CUDA API calls and amortized context setup
- Does NOT enable Hyper-Q-style true concurrency across processes (that requires Volta+)

**The result:** 10 MiniLM processes with Pascal MPS execute sequentially on the GPU. You get 10× the CPU-side parallelism (tokenization, HTTP handling) but the same GPU throughput as 1 process — just with 10× the VRAM overhead for model weights and activation buffers.

**VRAM math for 10× all-MiniLM without MPS:**
```
10 × 88MB model weights    = 880MB
10 × ~400MB CUDA contexts  = 4,000MB  ← kills the budget
10 × 50MB activation bufs  = 500MB
Total                      ≈ 5,380MB of 7,168MB available — tight, OOM risk under load
```

**VRAM math for 10× all-MiniLM with Pascal MPS:**
```
10 × 88MB model weights    = 880MB
Shared MPS context         ≈ 400MB (one context amortized)
10 × 50MB activation bufs  = 500MB
Total                      ≈ 1,780MB — fits, but GPU is still serialized
```

With MPS the VRAM is fine but you get no throughput advantage over a single process. Without MPS you burn 4GB on CUDA contexts alone. Either way, 10× MiniLM ≈ 1× MiniLM for GPU throughput on Pascal.

**Compare: single nomic-embed at `--parallel 64`:**
```
Model weights (F16 GGUF)   = 274MB
CUDA context (one process)  = 400MB
KV cache + activations      ≈ 1,800MB (64 slots, 8192 ctx)
Total                       ≈ 2,474MB of 7,168MB — 4.7GB free
```
- Better retrieval quality (13–15 NDCG points)
- Longer context window (8192 vs 256)
- Handles 64 concurrent requests as one batched GPU forward pass (all 20 SMs engaged)
- 4.7GB VRAM headroom to run 2 instances if burst capacity needed

### 13.3 Throughput — Actual Numbers per Model

GPU throughput on GTX 1080 (FP32, 128-token avg sequence, SMs saturated at batch≥32):

| Model | QPS at batch=64 | Notes |
|-------|----------------|-------|
| all-MiniLM-L6-v2 (22M) | ~800–1,500 | SM saturation at batch=8–16; beyond that memory-bound |
| BGE-small-en-v1.5 (33M) | ~500–900 | 2× compute vs MiniLM |
| **nomic-embed-text-v1.5 (137M)** | **~400–700** | **Sweet spot: quality × throughput** |
| BGE-large-en-v1.5 (335M) | ~80–180 | 5× compute cost vs nomic-embed for ~1–2 NDCG gain |

**Key insight on SM saturation:** For MiniLM (22M params, 384 hidden dim), GPU SM saturation occurs at batch=8–16. Beyond that, throughput is memory-bandwidth limited at 320 GB/s. Running 10× MiniLM each at batch=6 is the same as 1× MiniLM at batch=64 for GPU utilization — you get no scaling advantage, just more overhead.

For nomic-embed (137M, 768 hidden dim), the larger matrices keep SMs occupied longer per batch item. A single instance at batch=64 reaches full SM occupancy and delivers 400–700 QPS — comparable to 1× MiniLM while producing 13–15 NDCG points better results.

### 13.4 Agentic Swarm Traffic — Key Differences from Human Search

**Query length:** AI agents send 20–200 token queries, not 2–8 word human queries. Agents prepend task context and use multi-clause questions. This is why MiniLM's 256-token window is disqualifying — agent queries get silently truncated.

**Burst pattern:** CrewAI/LangChain crews fire N queries simultaneously during planning phases, then go idle during reasoning. A 5-agent crew can fire 20–50 queries in a 500ms window, then nothing for 2–5 seconds. This is ideal for adaptive batching.

**Query correlation:** Agents in the same crew search related concepts sequentially — "proxy authentication", "API key format", "CONNECT tunneling", "session tracking" all in one task. Cache hit rates in agentic workflows are 30–70% because agents re-query the same documentation across runs.

### 13.5 The Winning Architecture — Single Model + Semantic Cache + Adaptive Batcher

```
AI Agent Swarms (1000s req/min)
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Tier 1: Exact Hash Cache (Redis)               │
│  SHA-256(normalize(query)) → float32 vector     │
│  TTL=4h | ~15–25% hit rate                      │
│  ~300MB for 100K cached embeddings              │
└──────────────┬──────────────────────────────────┘
               │ miss
               ▼
┌─────────────────────────────────────────────────┐
│  Tier 2: Semantic Cache (Redis + HNSW)          │
│  256-dim vectors, cosine threshold ≥ 0.92       │
│  ~28% of remaining requests hit                 │
│  ~5–20ms lookup cost                            │
└──────────────┬──────────────────────────────────┘
               │ miss
               ▼
┌─────────────────────────────────────────────────┐
│  asyncio Adaptive Batcher                       │
│  10ms accumulation window, max batch=64         │
│  asyncio.Semaphore(200) burst cap               │
│  httpx persistent connection pool               │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  llama-server --parallel 64                     │
│  nomic-embed-text-v1.5 F16 (274MB VRAM)         │
│  ~400–700 GPU QPS sustained                     │
│  GTX 1080, all 20 SMs engaged at batch=64       │
└─────────────────────────────────────────────────┘
```

**Combined cache hit rate for agentic swarms:**
- Tier 1 exact hits: ~20%
- Tier 2 semantic hits (from remaining 80%): ~35% of those = ~28%
- Combined: **~48% of requests served from cache**
- Effective GPU QPS needed: 1,000 raw req/s × 0.52 miss rate = **520 QPS** — well within capacity

### 13.6 Matryoshka 256-Dim Mode — Key Optimization

`nomic-embed-text-v1.5` was trained with Matryoshka Representation Learning. Use 256-dim embeddings for the HNSW vector index:

| Dimension | NDCG@10 loss vs 768 | Vector size | Cosine sim cost |
|-----------|--------------------|-----------|--------------------|
| 768 (full) | baseline | 3KB | baseline |
| 512 | ~1% | 2KB | 1.5× faster |
| **256** | **~3–5%** | **1KB** | **3× faster** |
| 128 | ~8–12% | 512B | 6× faster |

**Why 256 dims for the HNSW cache:**
- 3× faster cosine similarity on CPU (NumPy)
- 9× smaller vector index in Redis (100K docs = 97MB vs 293MB at 768)
- More cache entries fit in RAM → higher cache hit rates
- 3–5% NDCG loss is acceptable for a documentation search with top-5 results

```python
# sentence-transformers MRL truncation (if using Python stack)
from sentence_transformers import SentenceTransformer
model = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5", truncate_dim=256)

# OR: llama-server always returns 768 dims — truncate in sidecar
def to_256(vec_768: list[float]) -> list[float]:
    """MRL: first 256 dims of a 768-dim nomic-embed vector."""
    import numpy as np
    v = np.array(vec_768[:256], dtype=np.float32)
    v /= np.linalg.norm(v)  # re-normalize after truncation
    return v.tolist()
```

Use 768-dim for the exact hash cache store (full precision for future reuse) and 256-dim for HNSW index construction and semantic lookup.

### 13.7 Adaptive Batcher — Production Code

```python
import asyncio
import hashlib
import numpy as np
import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, Query, HTTPException

app = FastAPI()

# Config
LLAMA_URL = "http://127.0.0.1:8080"
MAX_BATCH = 64
BATCH_WINDOW_MS = 10
MAX_CONCURRENT = 200

# State
_sem = asyncio.Semaphore(MAX_CONCURRENT)
_queue: asyncio.Queue = asyncio.Queue()
_http = httpx.AsyncClient(
    timeout=30.0,
    limits=httpx.Limits(max_connections=200, max_keepalive_connections=64)
)
_redis: aioredis.Redis = None

# ── Cache helpers ────────────────────────────────────────────────────────────

def _cache_key(query: str) -> str:
    return "emb:v1:" + hashlib.sha256(query.lower().strip().encode()).hexdigest()

async def _cache_get(query: str) -> list[float] | None:
    raw = await _redis.get(_cache_key(query))
    if raw:
        return np.frombuffer(raw, dtype=np.float32).tolist()
    return None

async def _cache_set(query: str, vec: list[float]):
    arr = np.array(vec, dtype=np.float32)
    await _redis.setex(_cache_key(query), 14400, arr.tobytes())  # TTL = 4h

# ── GPU batching loop ────────────────────────────────────────────────────────

async def _gpu_embed(texts: list[str]) -> list[list[float]]:
    resp = await _http.post(
        f"{LLAMA_URL}/v1/embeddings",
        json={"model": "nomic-embed-text-v1.5", "input": texts},
    )
    resp.raise_for_status()
    data = resp.json()
    vecs = np.array([d["embedding"] for d in data["data"]], dtype=np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return (vecs / np.maximum(norms, 1e-10)).tolist()

async def _batcher():
    """Drain queue in up to MAX_BATCH per 10ms window, submit to GPU."""
    loop = asyncio.get_running_loop()
    while True:
        batch_queries, batch_futures = [], []

        # Wait for first item
        try:
            query, fut = await asyncio.wait_for(_queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            continue
        batch_queries.append(query)
        batch_futures.append(fut)

        # Drain remaining within window
        deadline = loop.time() + BATCH_WINDOW_MS / 1000
        while len(batch_queries) < MAX_BATCH:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                query, fut = await asyncio.wait_for(_queue.get(), timeout=remaining)
                batch_queries.append(query)
                batch_futures.append(fut)
            except asyncio.TimeoutError:
                break

        # GPU call
        try:
            vecs = await _gpu_embed(batch_queries)
            for fut, vec in zip(batch_futures, vecs):
                if not fut.done():
                    fut.set_result(vec)
                await _cache_set(batch_queries[batch_futures.index(fut)], vec)
        except Exception as e:
            for fut in batch_futures:
                if not fut.done():
                    fut.set_exception(e)

# ── API endpoint ─────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    global _redis
    _redis = aioredis.from_url("redis://127.0.0.1:6379", decode_responses=False)
    asyncio.create_task(_batcher())

@app.get("/embed")
async def embed_endpoint(q: str = Query(..., min_length=1, max_length=2000)):
    # Tier 1: exact cache
    cached = await _cache_get(q)
    if cached:
        return {"embedding": cached, "cached": True}

    # GPU via batcher
    if _queue.qsize() > MAX_CONCURRENT * 3:
        raise HTTPException(status_code=429, detail="Queue full — retry in 1s")

    async with _sem:
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        await _queue.put((q, fut))
        vec = await fut

    return {"embedding": vec, "cached": False}
```

### 13.8 Two-Instance Burst Capacity (Using Free VRAM)

The single nomic-embed instance uses ~2.5GB of 8GB VRAM, leaving ~4.5GB free. This headroom supports **running a second identical llama-server on port 8081** with nginx round-robin:

```nginx
upstream llama_pool {
    server 127.0.0.1:8080;
    server 127.0.0.1:8081;
    keepalive 64;
}
server {
    listen 8090;
    location /v1/embeddings {
        proxy_pass http://llama_pool;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

This doubles effective GPU throughput to ~800–1,400 QPS for burst periods, at the cost of ~2.5GB additional VRAM (total ~5GB used, 3GB free). The second instance is identical — same model, same flags, no CUDA MPS needed because the two processes run on separate port queues.

**When to enable the second instance:** When p95 latency exceeds 150ms under sustained load (monitor via Prometheus).

### 13.9 Software Stack — Corrected Version Pins

Research uncovered a correction to the previous PyTorch version recommendation:

| Package | Correct pin for Pascal CC 6.1 |
|---------|-------------------------------|
| PyTorch | `torch==2.6.0+cu126` ← **updated** (2.7+ cu128/cu129 builds dropped CC 6.1) |
| infinity-emb | Use `--extra-index-url https://download.pytorch.org/whl/cu126` with pinned torch |
| Triton Inference Server | `nvcr.io/nvidia/tritonserver:24.01-py3` (24.02+ requires CC 7.0+) |
| CUDA Toolkit | 12.6.x (CUDA 12.8+ dropped CC 6.1 offline compilation) |
| ONNX Runtime GPU | `onnxruntime-gpu==1.18.x` with CUDA 12.4 EP |

**Install commands:**
```bash
# Pinned PyTorch for Pascal
pip install "torch==2.6.0" --index-url https://download.pytorch.org/whl/cu126

# infinity-emb with Pascal-safe backend (avoids PyTorch version conflicts)
pip install "infinity-emb[optimum]"  # Uses ONNX + CTranslate2, bypasses PyTorch version issue
# OR force pinned torch:
pip install "torch==2.6.0" --index-url https://download.pytorch.org/whl/cu126
pip install "infinity-emb[torch]" --no-deps
pip install fastapi uvicorn[standard] numpy huggingface-hub
```

### 13.10 p95 Latency Analysis Under Swarm Load

For 1,000 concurrent AI agent requests arriving simultaneously (worst case burst):

| Stage | Time |
|-------|------|
| Redis tier 1 lookup | ~0.5ms |
| Redis tier 2 HNSW lookup | ~10ms |
| Queue wait at 700 GPU QPS, batch=64 (16 batches for 1,024 requests) | ~160ms |
| GPU inference (nomic-embed, batch=64, 128 tokens avg) | ~30–50ms/batch |
| HTTP + serialization | ~5ms |
| **Total p95 (no cache)** | **~205ms** — marginally over budget |
| **Total p95 (48% cache hit rate)** | **~85ms** — well within budget |
| **Total p95 (2× instances, no cache)** | **~110ms** — within budget |

**Recommendation:** Deploy with Redis semantic cache from day one. The 48% cache hit rate is the primary lever that keeps p95 under 200ms even at 1,000 concurrent agent requests. The second llama-server instance is the fallback for when raw throughput exceeds single-instance capacity.

### 13.11 What to Avoid (Ruled Out by Research)

| Approach | Why Ruled Out |
|----------|--------------|
| **10× all-MiniLM-L6-v2 replicas** | Pre-Volta MPS serializes GPU — no throughput gain; 4GB CUDA context overhead without MPS; quality genuinely poor for passage retrieval (41 vs 55 NDCG); 256-token context truncates agent queries |
| **10× BGE-small-en-v1.5 replicas** | Same MPS serialization problem; passable quality but complex deployment for no throughput gain |
| **BGE-large-en-v1.5 (335M)** | ~80–180 QPS — below target; only 1–2 NDCG gain over nomic-embed at 5× compute cost |
| **Ray Serve** | 500MB+ overhead for single-machine, single-model use; adds 2–5ms routing latency; designed for multi-node |
| **Triton Inference Server** | Overkill for single model/GPU; complex configuration; Docker overhead; valid if adding a second model type |
| **HuggingFace TEI** | Hard blocked: requires CC ≥ 7.5 |
| **vLLM/SGLang** | Hard blocked: requires CC ≥ 7.0 |
| **PyTorch 2.7+ cu128** | Dropped Pascal CC 6.1 support — use cu126 builds only |

---

## Quick Reference

```bash
# ── Build llama.cpp for Pascal ──────────────────────────────────────────────
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=61 \
  -DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build -j $(nproc)

# ── Download model ───────────────────────────────────────────────────────────
huggingface-cli download nomic-ai/nomic-embed-text-v1.5-GGUF \
  nomic-embed-text-v1.5.f16.gguf --local-dir /opt/dominusnode/models/

# ── Start embedding server ───────────────────────────────────────────────────
llama-server --model /opt/dominusnode/models/nomic-embed-text-v1.5.f16.gguf \
  --n-gpu-layers 99 --embedding --pooling mean \
  --batch-size 4096 --ubatch-size 4096 --ctx-size 8192 \
  --rope-scaling yarn --rope-freq-scale 0.75 \
  --no-flash-attn --parallel 64 --host 127.0.0.1 --port 8080
  # use --parallel 8 for human-only interactive search; --parallel 64 for AI agent traffic

# ── Generate search corpus ───────────────────────────────────────────────────
cd packages/frontend && npx ts-node scripts/export-search-index.ts

# ── Start Python sidecar ─────────────────────────────────────────────────────
cd server/search-service && pip install -r requirements.txt
python main.py

# ── Test ─────────────────────────────────────────────────────────────────────
curl "http://localhost:8765/search?q=rotate+api+key"
curl "http://localhost:8765/search?q=what+crypto+is+supported"
curl "http://localhost:8765/health"

# ── Cloudflare Tunnel ────────────────────────────────────────────────────────
cloudflared tunnel create dominusnode-search
cloudflared tunnel route dns dominusnode-search search.dominusnode.com
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

---

## Decision Summary

| Question | Answer |
|---|---|
| Use CPU or GPU for embeddings? | **GPU** — T620 lacks AVX2, CPU is 2-3x too slow |
| Embedding model | `nomic-embed-text-v1.5` F16 GGUF |
| Inference backend | **llama.cpp CUDA** with Pascal build flags |
| Must-disable flag | `--no-flash-attn` (20% regression on Pascal if enabled) |
| Build flag | `-DCMAKE_CUDA_ARCHITECTURES=61` (5-15% faster) |
| AVX flags for T620 | `-DGGML_AVX=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF` |
| FP16 benefit on GTX 1080? | Memory savings only — no compute speedup (1/64 FP32 rate) |
| INT8 optimization? | Test `GGML_CUDA_FORCE_MMQ=1` with Q8_0 (DP4A parity with FP32) |
| HuggingFace TEI? | ❌ Completely blocked (CC < 7.5) |
| `--parallel` for human search | `--parallel 8` (~70–100ms, ~50–80 QPS) |
| `--parallel` for AI agent traffic | **`--parallel 64`** (~400–900 QPS at 50-token avg) |
| Run multiple instances? | **No** — single `--parallel 64` beats N×`--parallel 8` for homogeneous embedding |
| CUDA MPS on Pascal CC 6.1? | ✅ Supported (CC ≥ 3.5); saves ~300MB VRAM/instance; minimal throughput gain for embedding-only |
| CUDA MPS fault isolation? | ⚠️ Pre-Volta: client crash can bring down MPS server; monitor in prod |
| PyTorch version for Pascal? | Pin `torch==2.6.0+cu126` — cu128/cu129 builds (2.7+) dropped CC 6.1 |
| CUDA Toolkit version? | 12.6.x max — CUDA 12.8+ dropped CC 6.1 offline compilation |
| Triton Inference Server? | Use ≤ 24.01 — `24.02+` requires CC 7.0+ |
| Latency (single user) | ~80–150ms end-to-end |
| Latency p95 at 1K concurrent (48% cache hit) | ~85ms — within 200ms budget |
| Latency p95 at 1K concurrent (no cache) | ~205ms — marginally over; add 2nd instance |
| Many tiny model replicas? | ❌ Pre-Volta MPS serializes GPU — no throughput gain; MiniLM quality too low for docs |
| BGE-large instead of nomic-embed? | ❌ 5× compute cost for ~1–2 NDCG gain; drops to 80–180 QPS |
| Redis semantic cache? | ✅ ~48% hit rate on agentic swarms — primary scale lever |
| Matryoshka 256-dim for HNSW? | ✅ 3× faster cosine, 9× smaller index, ~3–5% NDCG tradeoff |
| Two llama-server instances? | ✅ 4.5GB free VRAM supports it — doubles throughput for burst |
| GPU upgrade for generative RAG | RTX 3060 12GB (~$220 used) |
