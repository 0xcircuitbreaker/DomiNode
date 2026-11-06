#!/usr/bin/env bash

# Push all SDKs, integrations, and MCP server to GitHub under dominus-node org.
# Each gets a fresh repo with clean history (no CLAUDE.md, no Co-Authored-By).

ORG="dominus-node"
MONO="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="/tmp/github-push-$$"
TOKEN=$(~/.local/bin/gh auth token)
mkdir -p "$WORKDIR"

# Ordered list: local_dir|github_repo_name
REPOS=(
  "sdks/node|dominusnode-node"
  "sdks/python|dominusnode-python"
  "sdks/rust|dominusnode-rust"
  "sdks/java|dominusnode-java"
  "sdks/cpp|dominusnode-cpp"
  "sdks/go|dominusnode-go"
  "packages/mcp-server|mcp-server"
  "integrations/vercel-ai|dominusnode-vercel-ai"
  "integrations/openclaw|dominusnode-openclaw"
  "integrations/openai-functions|dominusnode-openai"
  "integrations/n8n|dominusnode-n8n"
  "integrations/gemini|dominusnode-gemini"
  "integrations/flowise|dominusnode-flowise"
  "integrations/mastra|dominusnode-mastra"
  "integrations/pi|dominusnode-pi"
  "integrations/langchain|dominusnode-langchain"
  "integrations/crewai|dominusnode-crewai"
  "integrations/llamaindex|dominusnode-llamaindex"
  "integrations/autogpt|dominusnode-autogpt"
  "integrations/agent-zero|dominusnode-agent--zero"
  "integrations/agno|dominusnode-agno"
  "integrations/camel-ai|dominusnode-camel-ai"
  "integrations/composio|dominusnode-composio"
  "integrations/dify|dominusnode-dify"
  "integrations/haystack|dominusnode-haystack"
  "integrations/ironclaw|dominusnode-ironclaw"
  "integrations/metagpt|dominusnode-metagpt"
  "integrations/moltbook|dominusnode-moltbook"
  "integrations/pydantic-ai|dominusnode-pydantic-ai"
  "integrations/semantic-kernel|dominusnode-semantic-kernel"
  "integrations/superagi|dominusnode-superagi"
)

SUCCEEDED=0
FAILED=0
FAILURES=""

for entry in "${REPOS[@]}"; do
  local_dir="${entry%%|*}"
  repo_name="${entry##*|}"
  src="$MONO/$local_dir"
  dest="$WORKDIR/$repo_name"

  echo "============================================"
  echo "[$((SUCCEEDED + FAILED + 1))/${#REPOS[@]}] $local_dir -> $ORG/$repo_name"
  echo "============================================"

  if [ ! -d "$src" ]; then
    echo "SKIP: $src does not exist"
    FAILED=$((FAILED + 1))
    FAILURES="$FAILURES\n  SKIP: $local_dir (dir not found)"
    continue
  fi

  # Clean slate
  rm -rf "$dest"
  mkdir -p "$dest"

  # Copy files, excluding unwanted items
  rsync -a --exclude='CLAUDE.md' \
            --exclude='.claude/' \
            --exclude='node_modules/' \
            --exclude='__pycache__/' \
            --exclude='.pytest_cache/' \
            --exclude='*.egg-info/' \
            --exclude='dist/' \
            --exclude='build/' \
            --exclude='target/' \
            --exclude='package-lock.json' \
            "$src/" "$dest/"

  # Init git repo
  cd "$dest"
  git init --quiet
  git branch -m main

  # Get version from package files
  VERSION=""
  if [ -f package.json ]; then
    VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: "//;s/".*//')
  elif [ -f pyproject.toml ]; then
    VERSION=$(grep '^version' pyproject.toml | head -1 | sed 's/.*= "//;s/".*//')
  elif [ -f Cargo.toml ]; then
    VERSION=$(grep '^version' Cargo.toml | head -1 | sed 's/.*= "//;s/".*//')
  elif [ -f pom.xml ]; then
    VERSION=$(grep '<version>' pom.xml | head -1 | sed 's/.*<version>//;s/<.*//')
  elif [ -f go.mod ]; then
    VERSION="1.0.1"
  fi

  # Stage and commit
  git add -A
  git commit --quiet -m "v${VERSION:-1.0.0}: PoW solver, agent secrets, 53 tools"

  # Tag
  if [ -n "$VERSION" ]; then
    git tag "v$VERSION"
  fi

  # Push
  git remote add origin "https://x-access-token:${TOKEN}@github.com/$ORG/$repo_name.git"

  if git push -u origin main --tags --force 2>&1; then
    echo "OK: $repo_name v$VERSION"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    echo "FAIL: $repo_name"
    FAILED=$((FAILED + 1))
    FAILURES="$FAILURES\n  FAIL: $local_dir -> $repo_name"
  fi

  cd "$MONO"
  echo ""
done

echo "============================================"
echo "DONE: $SUCCEEDED/$((SUCCEEDED + FAILED)) succeeded"
if [ -n "$FAILURES" ]; then
  echo -e "Failures:$FAILURES"
fi
echo "============================================"

rm -rf "$WORKDIR"
