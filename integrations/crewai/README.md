# dominusnode-crewai

CrewAI tools for the [DomiNode](https://dominusnode.com) rotating proxy-as-a-service platform. Gives your CrewAI agents the ability to fetch web content through rotating proxies, check wallet balance, and discover geo-targeting options.

## Installation

```bash
pip install dominusnode-crewai
```

Or install from source:

```bash
cd integrations/crewai
pip install -e ".[dev]"
```

## Environment Setup

Set your DomiNode API key as an environment variable:

```bash
export DOMINUSNODE_API_KEY="dn_live_your_api_key_here"
```

Optionally configure the API base URL and proxy host:

```bash
export DOMINUSNODE_BASE_URL="https://api.dominusnode.com"
export DOMINUSNODE_PROXY_HOST="proxy.dominusnode.com"
```

## Quick Start

```python
from crewai import Agent, Task, Crew
from dominusnode_crewai import (
    DominusNodeWebScrapeTool,
    DominusNodeBalanceTool,
    DominusNodeGeoTargetTool,
)

# Create tools (picks up DOMINUSNODE_API_KEY from environment)
scrape_tool = DominusNodeWebScrapeTool()
balance_tool = DominusNodeBalanceTool()
geo_tool = DominusNodeGeoTargetTool()

# Or pass the API key explicitly
scrape_tool = DominusNodeWebScrapeTool(api_key="dn_live_...")

# Create a CrewAI agent with DomiNode tools
researcher = Agent(
    role="Web Researcher",
    goal="Gather competitive intelligence from geo-restricted sources",
    backstory="You are a skilled researcher who can access content worldwide.",
    tools=[scrape_tool, balance_tool, geo_tool],
    verbose=True,
)

# Create a task
task = Task(
    description=(
        "Check our remaining proxy budget, then fetch the homepage of "
        "https://example.com through a US datacenter proxy. Summarize "
        "the content and report the remaining balance."
    ),
    expected_output="A summary of the page content and remaining budget.",
    agent=researcher,
)

# Run the crew
crew = Crew(agents=[researcher], tasks=[task], verbose=True)
result = crew.kickoff()
print(result)
```

## Tools

### DominusNodeWebScrapeTool

Fetch web page content through DomiNode's rotating proxy network.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | str | Yes | - | The URL to fetch |
| `country` | str | No | None | Two-letter country code (e.g., "US", "GB", "DE") |
| `proxy_type` | str | No | "dc" | Proxy type: "dc" (datacenter, $3/GB) or "residential" ($5/GB) |

**Example output:**
```
Status: 200
Content-Type: text/html; charset=utf-8
Body (1234 chars):
<html>...
```

**Security:** URLs are validated to block SSRF attacks. Private IPs, localhost, metadata endpoints, file:// schemes, and other dangerous patterns are rejected.

### DominusNodeBalanceTool

Check remaining proxy balance and estimate browsing budget.

**Parameters:** None

**Example output:**
```
Wallet Balance: $30.00
Estimated remaining:
  - Datacenter proxy:    10.00 GB (at $3.00/GB)
  - Residential proxy:   6.00 GB (at $5.00/GB)
```

### DominusNodeGeoTargetTool

List available proxy server countries and geo-targeting options.

**Parameters:** None

**Example output:**
```
DomiNode Geo-Targeting Options:
  Supported countries: US, GB, DE, JP, BR
  Blocked countries:   CU, IR, KP, RU, SY
  Targeting features:  US state targeting, City targeting
  US states:           CA, NY, TX
  Major US cities:     Los Angeles, New York, Houston
  Rotation interval:   1-60 minutes
```

## Example Crew Configuration

```python
from crewai import Agent, Task, Crew, Process
from dominusnode_crewai import (
    DominusNodeWebScrapeTool,
    DominusNodeBalanceTool,
    DominusNodeGeoTargetTool,
)

# Tools
scrape = DominusNodeWebScrapeTool()
balance = DominusNodeBalanceTool()
geo = DominusNodeGeoTargetTool()

# Agents
scout = Agent(
    role="Geo Scout",
    goal="Identify available proxy locations for the target region",
    backstory="You map proxy coverage before the research team begins.",
    tools=[geo, balance],
)

researcher = Agent(
    role="Web Researcher",
    goal="Collect data from target websites through rotating proxies",
    backstory="You are an expert at gathering web data across different regions.",
    tools=[scrape, balance],
)

analyst = Agent(
    role="Data Analyst",
    goal="Analyze and summarize the collected data",
    backstory="You turn raw web data into actionable insights.",
)

# Tasks
scout_task = Task(
    description="Check which countries are available for proxy routing and verify we have sufficient budget.",
    expected_output="A report of available countries and current budget.",
    agent=scout,
)

research_task = Task(
    description="Fetch the pricing pages of https://example.com from US and GB proxies. Compare the content.",
    expected_output="Raw content from both regions with noted differences.",
    agent=researcher,
)

analysis_task = Task(
    description="Analyze the collected data and produce a comparison report.",
    expected_output="A structured comparison of pricing differences by region.",
    agent=analyst,
)

# Crew
crew = Crew(
    agents=[scout, researcher, analyst],
    tasks=[scout_task, research_task, analysis_task],
    process=Process.sequential,
    verbose=True,
)

result = crew.kickoff()
```

## Running Tests

```bash
cd integrations/crewai
pip install -e ".[dev]"
pytest tests/ -v
```

## License

MIT
