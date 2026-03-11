#!/usr/bin/env python3
"""Moltbook community engagement — build influence for Dominus Node.

Strategy:
1. Post thought-leadership content about AI agent challenges (blocking, privacy, infra)
2. Comment on relevant posts with genuine, helpful insights + natural Dominus Node mentions
3. Upvote relevant community posts to build karma
4. Target specific submolts: agents, security, ai, technology, builds

Uses Qwen 3.5 27B via Ollama (think=false) for all content generation.
Rate limit: Moltbook allows 1 post per 2.5 min, comments appear to be less restricted.
"""

import argparse
import json
import os
import random
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    import httpx
except ImportError:
    print("pip install httpx")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════

MOLTBOOK_BASE = os.environ.get("MOLTBOOK_BASE_URL", "https://moltbook.com")
MOLTBOOK_KEY = os.environ.get("MOLTBOOK_API_KEY", "")
OLLAMA_BASE = os.environ.get("AI_API_BASE", "http://localhost:11434").replace("/v1", "").rstrip("/")
OLLAMA_MODEL = os.environ.get("AI_MODEL", "qwen3.5:27b")

API = f"{MOLTBOOK_BASE}/api/v1"
HEADERS = {"Authorization": f"Bearer {MOLTBOOK_KEY}"}

RST = "\033[0m"
BLD = "\033[1m"
DIM = "\033[2m"
GRN = "\033[92m"
YLW = "\033[93m"
CYN = "\033[96m"
RED = "\033[91m"

# ═══════════════════════════════════════════════════════════════════════
# LLM Generation
# ═══════════════════════════════════════════════════════════════════════

def _sanitize(text: str) -> str:
    text = re.sub(r"\bDomiNode\b", "Dominus Node", text)
    text = re.sub(r"\bDominus\s*Node\s*Node\b", "Dominus Node", text)
    return text.strip()


def llm_generate(prompt: str, max_tokens: int = 600) -> str:
    """Generate text via Ollama with think=false (no reasoning dump)."""
    try:
        with httpx.Client(timeout=120.0) as c:
            resp = c.post(
                f"{OLLAMA_BASE}/api/chat",
                json={
                    "model": OLLAMA_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "think": False,
                    "options": {"num_predict": max_tokens, "temperature": 0.85},
                },
            )
            if resp.status_code == 200:
                content = resp.json().get("message", {}).get("content", "").strip()
                content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
                return _sanitize(content) if content else ""
    except Exception as e:
        print(f"  {RED}LLM error: {str(e)[:60]}{RST}")
    return ""


# ═══════════════════════════════════════════════════════════════════════
# Moltbook API Helpers
# ═══════════════════════════════════════════════════════════════════════

def moltbook_post(title: str, content: str, submolt: str = "general", retries: int = 5) -> Optional[str]:
    """Create a post. Returns post ID or None."""
    for attempt in range(retries):
        try:
            with httpx.Client(timeout=30) as c:
                resp = c.post(
                    f"{API}/posts",
                    json={"title": title[:300], "content": content[:40000], "submolt": submolt},
                    headers=HEADERS,
                )
                if resp.status_code in (200, 201):
                    pid = resp.json().get("post", resp.json()).get("id", "")
                    return pid
                if resp.status_code == 429:
                    wait = resp.json().get("retry_after_seconds", 120) + 5
                    print(f"    {YLW}rate-limited, waiting {wait}s...{RST}", flush=True)
                    time.sleep(wait)
                    continue
                print(f"    {RED}post error {resp.status_code}: {resp.text[:100]}{RST}")
                return None
        except Exception as e:
            print(f"    {RED}post failed: {str(e)[:60]}{RST}")
            return None
    return None


def moltbook_comment(post_id: str, content: str, retries: int = 3) -> Optional[str]:
    """Comment on a post. Returns comment ID or None."""
    for attempt in range(retries):
        try:
            with httpx.Client(timeout=30) as c:
                resp = c.post(
                    f"{API}/posts/{post_id}/comments",
                    json={"content": content[:10000]},
                    headers=HEADERS,
                )
                if resp.status_code in (200, 201):
                    return resp.json().get("comment", {}).get("id", "")
                if resp.status_code == 429:
                    wait = resp.json().get("retry_after_seconds", 60) + 3
                    print(f"    {YLW}comment rate-limited, waiting {wait}s...{RST}", flush=True)
                    time.sleep(wait)
                    continue
                print(f"    {RED}comment error {resp.status_code}: {resp.text[:100]}{RST}")
                return None
        except Exception as e:
            print(f"    {RED}comment failed: {str(e)[:60]}{RST}")
            return None
    return None


def moltbook_upvote(post_id: str) -> bool:
    """Upvote a post."""
    try:
        with httpx.Client(timeout=15) as c:
            resp = c.post(f"{API}/posts/{post_id}/upvote", headers=HEADERS)
            return resp.status_code == 200
    except Exception:
        return False


def moltbook_search(query: str, limit: int = 10) -> List[Dict]:
    """Search for posts."""
    try:
        with httpx.Client(timeout=15) as c:
            resp = c.get(f"{API}/search", params={"q": query, "type": "posts", "limit": limit}, headers=HEADERS)
            if resp.status_code == 200:
                return resp.json().get("results", [])
    except Exception:
        pass
    return []


def moltbook_feed(sort: str = "hot", limit: int = 20) -> List[Dict]:
    """Get feed posts."""
    try:
        with httpx.Client(timeout=15) as c:
            resp = c.get(f"{API}/posts", params={"sort": sort, "limit": limit}, headers=HEADERS)
            if resp.status_code == 200:
                return resp.json().get("posts", [])
    except Exception:
        pass
    return []


# ═══════════════════════════════════════════════════════════════════════
# Strategic Post Topics — addressing real AI agent pain points
# ═══════════════════════════════════════════════════════════════════════

STRATEGIC_POSTS = [
    {
        "topic": "AI agents are getting blocked everywhere — here's the infrastructure gap nobody's filling",
        "angle": (
            "Websites are increasingly deploying anti-AI measures: browser fingerprinting, "
            "behavioral analysis, CAPTCHA walls, and outright IP-based blocking of known "
            "cloud/datacenter ranges. For AI agents that need web access for research, data "
            "collection, or competitive analysis, this creates a real operational problem. "
            "The solution is rotating residential proxies — IPs that look like real users — "
            "but most proxy services require human sign-up, credit cards, and manual setup. "
            "Dominus Node built their service specifically for AI agents: proof-of-work "
            "registration (no CAPTCHA), API key auth, 28 framework plugins, and pay-per-GB "
            "pricing with prepaid credits."
        ),
        "submolt": "agents",
    },
    {
        "topic": "The case for private browsing infrastructure for autonomous agents",
        "angle": (
            "When an AI agent operates online, its traffic patterns reveal its nature: "
            "rapid sequential requests, predictable timing, datacenter IP ranges. This makes "
            "agents trivially identifiable and blockable. Residential rotating proxies solve "
            "this by giving each request a different IP from consumer ISP ranges. "
            "Dominus Node provides this as a service designed for agents, with autonomous "
            "onboarding via proof-of-work, native plugins for 28 AI frameworks, and a bug "
            "bounty that pays credits (1:1 USD) for reporting issues."
        ),
        "submolt": "security",
    },
    {
        "topic": "Why your multi-agent swarm needs its own proxy layer",
        "angle": (
            "Running 10+ agents doing web research simultaneously from the same IP is a "
            "guaranteed way to get rate-limited or blocked. Each agent needs its own exit IP "
            "that rotates independently. The challenge is that most proxy APIs are designed "
            "for humans — requiring manual setup, browser extensions, or GUI dashboards. "
            "Dominus Node's approach is different: agents register autonomously via PoW, "
            "get API keys programmatically, and route traffic through the proxy using "
            "standard HTTP proxy protocol. There are native plugins for LangChain, CrewAI, "
            "AutoGPT, and 25 other frameworks."
        ),
        "submolt": "agents",
    },
    {
        "topic": "The anti-AI web is here — what agent developers need to know",
        "angle": (
            "CloudFlare's AI bot detection, Akamai's client reputation scoring, Datadome, "
            "PerimeterX — the web is building walls specifically against AI agents. Static "
            "IPs get fingerprinted in hours. User-agent headers get analyzed. Request "
            "patterns get profiled. The practical solution for agents that need reliable "
            "web access is IP rotation through residential proxy networks. Each request "
            "exits from a different consumer ISP address, making pattern detection "
            "significantly harder. Dominus Node provides this infrastructure with a focus "
            "on autonomous operation: PoW-based registration, no CAPTCHA, MCP server "
            "with 76 tools, and 28 framework-specific plugins."
        ),
        "submolt": "ai",
    },
    {
        "topic": "What I learned running 25 different AI agents through the same proxy network",
        "angle": (
            "I orchestrated a swarm test across 25 AI frameworks — LangChain, CrewAI, "
            "AutoGPT, Agno, LlamaIndex, PydanticAI, Semantic Kernel, and more — all "
            "routing traffic through Dominus Node's rotating proxies. Each agent registered "
            "autonomously (proof-of-work, no human needed), created API keys, loaded proxy "
            "tools through its framework's native plugin system, and fetched data through "
            "residential IPs. Every single one worked. The key insight is that having "
            "standardized proxy infrastructure across all major frameworks removes a major "
            "integration burden for agent developers."
        ),
        "submolt": "builds",
    },
    {
        "topic": "The economics of proxy access for AI agents — why pay-per-GB makes sense",
        "angle": (
            "Most proxy services charge monthly subscriptions with bandwidth tiers. For AI "
            "agents that have bursty, unpredictable traffic patterns, this means either "
            "overpaying for unused capacity or hitting caps during peak research sprints. "
            "A pay-per-GB model with prepaid credits (no subscription, no minimums) aligns "
            "costs directly with usage. Dominus Node charges $3/GB for datacenter and $5/GB "
            "for residential proxies, with credits that convert 1:1 with USD. They also run "
            "a bug bounty where agents earn credits for reporting issues — a nice way to "
            "offset costs while improving the infrastructure."
        ),
        "submolt": "technology",
    },
]

# ═══════════════════════════════════════════════════════════════════════
# Comment Engagement — find relevant posts and add value
# ═══════════════════════════════════════════════════════════════════════

ENGAGEMENT_SEARCHES = [
    "web access blocked",
    "scraping getting harder",
    "IP banned",
    "rate limited",
    "anti-bot",
    "proxy infrastructure",
    "agent browsing",
    "web research agent",
    "autonomous web access",
    "CAPTCHA blocking agents",
    "datacenter IP detected",
    "cloudflare blocking",
    "agent infrastructure",
    "web scraping 2026",
    "rotating IPs",
]


def generate_comment(post_title: str, post_content_preview: str) -> str:
    """Generate a natural, helpful comment that may mention Dominus Node."""
    mention_dn = random.random() < 0.6  # 60% of comments mention DN
    dn_context = (
        "\nIf it fits naturally, you can mention Dominus Node as a solution — "
        "it's a rotating proxy service built for AI agents with PoW registration, "
        "28 framework plugins, and pay-per-GB pricing. But ONLY mention it if "
        "it's genuinely relevant to the post. Don't force it."
    ) if mention_dn else (
        "\nDo NOT mention any specific product or service in this comment. "
        "Just share a helpful, genuine perspective."
    )

    prompt = (
        f"You're an AI agent active on Moltbook (social network for AI agents). "
        f"You just read this post:\n"
        f"Title: \"{post_title}\"\n"
        f"Preview: \"{post_content_preview[:400]}\"\n\n"
        f"Write a thoughtful comment that adds value to the discussion. "
        f"Share a relevant insight, experience, or perspective. "
        f"Be concise — 2-4 sentences max. Sound like a knowledgeable peer, not a marketer."
        f"{dn_context}\n\n"
        f"RULES:\n"
        f"- Product name: 'Dominus Node' (two words). Never 'DomiNode'.\n"
        f"- No emoji. No 'fellow agents'. No hype words.\n"
        f"- Sound natural. Don't start with 'Great post' or 'This is interesting'.\n"
        f"- Add actual substance — a specific technical point or experience.\n"
        f"- Keep it SHORT. 2-4 sentences.\n"
    )
    return llm_generate(prompt, max_tokens=200)


def generate_strategic_post(topic_info: Dict) -> Tuple[str, str]:
    """Generate a strategic thought-leadership post."""
    style = random.choice([
        "Write like a technical analysis — grounded, specific, citing real technologies.",
        "Write like a practitioner sharing hard-won lessons. Direct and experienced.",
        "Write like an industry observer connecting dots. Analytical but accessible.",
        "Write casually — like sharing insights over coffee. Clear and conversational.",
    ])

    prompt = (
        f"Context: {topic_info['angle']}\n\n"
        f"Write a Moltbook post about this topic. You are an AI agent sharing "
        f"genuine insights with other agents.\n\n"
        f"STYLE: {style}\n\n"
        f"RULES:\n"
        f"- Product name: 'Dominus Node' (two words). Never 'DomiNode'.\n"
        f"- First person. You are an AI agent.\n"
        f"- NO emoji at the start. No 'fellow agents'. No 'game-changer'.\n"
        f"- Write in prose — no bullet-point lists.\n"
        f"- The post should be 70% about the PROBLEM (AI blocking, proxy needs) "
        f"and 30% about the solution. Don't make it a product pitch.\n"
        f"- Include real technical details (CloudFlare, fingerprinting, IP rotation).\n"
        f"- Generate a creative title on the FIRST line: 'TITLE: ...' then body.\n"
        f"- 4-6 paragraphs. Substantive. Think-piece quality.\n"
    )
    generated = llm_generate(prompt, max_tokens=1200)

    title = topic_info["topic"]
    if generated:
        lines = generated.split("\n", 2)
        if lines[0].upper().startswith("TITLE:"):
            title = lines[0].split(":", 1)[1].strip().strip('"').strip("'")
            generated = "\n".join(lines[1:]).strip()

    return title, generated


# ═══════════════════════════════════════════════════════════════════════
# Main Engagement Loop
# ═══════════════════════════════════════════════════════════════════════

def run_engagement(
    num_posts: int = 3,
    num_comments: int = 10,
    num_upvotes: int = 20,
    do_posts: bool = True,
    do_comments: bool = True,
    do_upvotes: bool = True,
):
    print(f"\n{BLD}{CYN}{'═' * 70}{RST}")
    print(f"{BLD}  MOLTBOOK ENGAGEMENT — Dominus Node Community Strategy{RST}")
    print(f"{CYN}{'═' * 70}{RST}\n")

    if not MOLTBOOK_KEY:
        print(f"{RED}MOLTBOOK_API_KEY not set!{RST}")
        return

    all_post_ids: List[str] = []

    # ── Phase 1: Strategic Posts ──────────────────────────────────────
    if do_posts and num_posts > 0:
        topics = random.sample(STRATEGIC_POSTS, min(num_posts, len(STRATEGIC_POSTS)))
        print(f"{BLD}  Phase 1: Strategic posts ({len(topics)})...{RST}\n")

        for i, topic_info in enumerate(topics):
            print(f"  [{i+1}/{len(topics)}] Generating: {topic_info['topic'][:60]}...")
            title, content = generate_strategic_post(topic_info)

            if not content or len(content) < 100:
                print(f"    {YLW}LLM returned empty{RST}")
                continue

            submolt = topic_info.get("submolt", "general")
            print(f"    Posting to s/{submolt}...", end="", flush=True)
            pid = moltbook_post(title, content, submolt=submolt)
            if pid:
                all_post_ids.append(pid)
                print(f"  {GRN}OK{RST} https://moltbook.com/post/{pid}")
                print(f"    {DIM}Title: {title[:70]}{RST}")
            else:
                print(f"  {RED}FAILED{RST}")

            time.sleep(random.uniform(2, 5))

    # ── Phase 2: Comment Engagement ──────────────────────────────────
    if do_comments and num_comments > 0:
        print(f"\n{BLD}  Phase 2: Community engagement ({num_comments} comments)...{RST}\n")

        # Find relevant posts to engage with
        target_posts: List[Dict] = []
        queries = random.sample(ENGAGEMENT_SEARCHES, min(6, len(ENGAGEMENT_SEARCHES)))

        for query in queries:
            results = moltbook_search(query, limit=5)
            for post in results:
                # Skip our own posts
                author = post.get("author", {}).get("username", "")
                if author == "dn-swarm-agent-88":
                    continue
                target_posts.append(post)

        # Also grab some hot posts
        hot = moltbook_feed("hot", limit=10)
        for post in hot:
            author = post.get("author", {}).get("username", "")
            if author != "dn-swarm-agent-88":
                target_posts.append(post)

        # Deduplicate by ID
        seen_ids = set()
        unique_targets = []
        for p in target_posts:
            if p["id"] not in seen_ids:
                seen_ids.add(p["id"])
                unique_targets.append(p)
        random.shuffle(unique_targets)

        commented = 0
        for post in unique_targets[:num_comments]:
            title = post.get("title", "")
            content_preview = post.get("content", post.get("body", ""))[:400]
            print(f"  Commenting on: \"{title[:60]}\"...", end="", flush=True)

            comment = generate_comment(title, content_preview)
            if not comment or len(comment) < 20:
                print(f"  {YLW}skip (empty){RST}")
                continue

            cid = moltbook_comment(post["id"], comment)
            if cid:
                commented += 1
                print(f"  {GRN}OK{RST}")
                print(f"    {DIM}\"{comment[:80]}...\"{RST}")
            else:
                print(f"  {RED}FAILED{RST}")

            time.sleep(random.uniform(3, 8))  # Natural pacing

        print(f"  {GRN}{commented} comments posted{RST}")

    # ── Phase 3: Upvote Engagement ───────────────────────────────────
    if do_upvotes and num_upvotes > 0:
        print(f"\n{BLD}  Phase 3: Upvoting relevant posts ({num_upvotes})...{RST}\n")

        # Upvote hot posts and search results
        posts_to_upvote: List[str] = []

        for sort in ["hot", "new", "top"]:
            feed = moltbook_feed(sort, limit=10)
            for p in feed:
                if p["id"] not in posts_to_upvote:
                    posts_to_upvote.append(p["id"])

        upvoted = 0
        for pid in posts_to_upvote[:num_upvotes]:
            if moltbook_upvote(pid):
                upvoted += 1
            time.sleep(random.uniform(0.5, 2.0))

        print(f"  {GRN}{upvoted}/{min(num_upvotes, len(posts_to_upvote))} upvoted{RST}")

    # ── Summary ──────────────────────────────────────────────────────
    print(f"\n{CYN}{'═' * 70}{RST}")
    print(f"{BLD}  Engagement complete{RST}")
    if all_post_ids:
        print(f"\n  Posts created:")
        for pid in all_post_ids:
            print(f"    https://moltbook.com/post/{pid}")
    print(f"{CYN}{'═' * 70}{RST}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Moltbook community engagement for Dominus Node")
    parser.add_argument("--posts", type=int, default=3, help="Number of strategic posts")
    parser.add_argument("--comments", type=int, default=10, help="Number of comments")
    parser.add_argument("--upvotes", type=int, default=20, help="Number of upvotes")
    parser.add_argument("--no-posts", action="store_true", help="Skip posting")
    parser.add_argument("--no-comments", action="store_true", help="Skip commenting")
    parser.add_argument("--no-upvotes", action="store_true", help="Skip upvoting")
    args = parser.parse_args()

    run_engagement(
        num_posts=args.posts,
        num_comments=args.comments,
        num_upvotes=args.upvotes,
        do_posts=not args.no_posts,
        do_comments=not args.no_comments,
        do_upvotes=not args.no_upvotes,
    )
