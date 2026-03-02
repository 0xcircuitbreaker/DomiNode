# AI Search Implementation Report
**Dominus Node Docs — Semantic Search Upgrade**
*Prepared: 2026-03-02 | Revised: 2026-03-02 (T620 / GTX 1080 reassessment)*
*Target hardware: Dell PowerEdge T620 + NVIDIA GTX 1080 8GB VRAM, Linux, behind Cloudflare*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Hardware Analysis — T620 CPU + GTX 1080 GPU](#2-hardware-analysis)
3. [Architecture Decision](#3-architecture-decision)
4. [Model Recommendations](#4-model-recommendations)
5. [GTX 1080 Pascal Optimizations (llama.cpp)](#5-gtx-1080-pascal-optimizations)
6. [Concurrency Analysis — GPU Embedding](#6-concurrency-analysis)
7. [Backend Comparison Matrix](#7-backend-comparison-matrix)
8. [Implementation Plan](#8-implementation-plan)
9. [Build & Run Commands](#9-build--run-commands)
10. [Full Python Sidecar Code](#10-full-python-sidecar-code)
11. [Cloudflare Tunnel Setup](#11-cloudflare-tunnel-setup)
12. [Future Generative Upgrade Path](#12-future-generative-upgrade-path)

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
  --parallel 8 \             # 8 concurrent embedding slots, batched together
  --host 127.0.0.1 \
  --port 8080
```

`--parallel 8` is the key setting for concurrent search requests. When 8 users submit searches simultaneously, the server collects all 8 query embeddings and processes them as a single GPU forward pass instead of 8 serial passes.

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

### Maximum Concurrent Searches at <100ms Latency

| `--parallel` setting | Concurrent capacity | Per-query latency |
|---------------------|--------------------|--------------------|
| 4 | 4 simultaneous | ~50–70ms |
| **8** | **8 simultaneous** | **~70–100ms** ← recommended |
| 16 | 12–16 simultaneous | ~100–150ms (some over 100ms) |

Above `--parallel 16`, per-request latency starts exceeding 100ms on the GTX 1080 for 200-token queries. Start with `--parallel 8` as the production default.

### Why Batching Helps More for Embeddings Than Generation

Autoregressive generation has a sequential dependency (each token depends on previous). Embeddings do not — the entire batch of N sequences can be processed as a single matrix multiply. The GTX 1080's 2,560 CUDA cores reach full occupancy around batch_size 8–16 for a 768-dim model, making `--parallel 8` the sweet spot where GPU utilization is maximized without queuing delay.

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
  --parallel 8 \
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
    --parallel 8 \
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
  --no-flash-attn --parallel 8 --host 127.0.0.1 --port 8080

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
| Concurrent search capacity | 8 simultaneous at ~100ms each (`--parallel 8`) |
| Latency (single user) | ~80–150ms end-to-end |
| GPU upgrade for generative RAG | RTX 3060 12GB (~$220 used) |
