<p align="center">
  <img src="alice-full.png" alt="Open Alice" width="128">
</p>

<p align="center">
  <a href="https://deepwiki.com/TraderAlice/OpenAlice"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a> · <a href="https://traderalice.com"><img src="https://img.shields.io/badge/Website-Visit-blue" alt="traderalice.com"></a>
</p>

# Open Alice

Your one-person Wall Street. Alice is an AI trading agent that gives you your own research desk, quant team, trading floor, and risk management — all running on your laptop 24/7.

- **File-driven** — Markdown defines persona and tasks, JSON defines config, JSONL stores conversations. Both humans and AI control Alice by reading and modifying files. The same read/write primitives that power vibe coding transfer directly to vibe trading. No database, no containers, just files.
- **Reasoning-driven** — every trading decision is based on continuous reasoning and signal mixing.
- **OS-native** — Alice can interact with your operating system, send messages via Telegram, and connect to local devices.

## Features

- **Dual AI provider** — switch between Claude Code CLI and Vercel AI SDK at runtime, no restart needed
- **Unified trading** — multi-account architecture supporting CCXT (Bybit, OKX, Binance, etc.) and Alpaca (US equities) with a git-like workflow (stage, commit, push)
- **Guard pipeline** — extensible pre-execution safety checks (max position size, cooldown between trades, symbol whitelist)
- **Market data** — OpenTypeBB-powered equity, crypto, commodity, and currency data layers with unified symbol search (`marketSearchForResearch`) and technical indicator calculator
- **Equity research** — company profiles, financial statements, ratios, analyst estimates, earnings calendar, insider trading, and market movers (top gainers, losers, most active)
- **News collector** — background RSS collection from configurable feeds with archive search tools (`globNews`/`grepNews`/`readNews`). Also captures OpenTypeBB news API results via piggyback
- **Cognitive state** — persistent "brain" with frontal lobe memory, emotion tracking, and commit history
- **Event log** — persistent append-only JSONL event log with real-time subscriptions and crash recovery
- **Cron scheduling** — event-driven cron system with AI-powered job execution and automatic delivery to the last-interacted channel
- **Evolution mode** — two-tier permission system. Normal mode sandboxes the AI to `runtime/brain/`; evolution mode gives full project access including Bash, enabling the agent to modify its own source code
- **Hot-reload** — enable/disable connectors (Telegram, MCP Ask) and reconnect trading engines at runtime without restart
- **Web UI** — local chat interface with portfolio dashboard and full config management (trading, data sources, connectors, settings)

## Key Concepts

**Provider** — The AI backend that powers Alice. Claude Code (subprocess) or Vercel AI SDK (in-process). Switchable at runtime via `ai-provider.json`.

**Domain Module** — A self-contained tool package registered in ToolCenter. Each domain module owns its tools, state, and persistence. They are grouped by function such as cognition, research, technical analysis, and trading.

**Trading** — A git-like workflow for trading operations. You stage orders, commit with a message, then push to execute. Every commit gets an 8-char hash. Full history is reviewable via `tradingLog` / `tradingShow`.

**Guard** — A pre-execution check that runs before every trading operation reaches the exchange. Guards enforce limits (max position size, cooldown between trades, symbol whitelist) and can be configured per-asset.

**Connector** — An external interface through which users interact with Alice. Built-in: Web UI, Telegram, MCP Ask. Connectors register with the ConnectorRegistry; delivery always goes to the channel of last interaction.

**Brain** — Alice's persistent cognitive state. The frontal lobe stores working memory across rounds; emotion tracking logs sentiment shifts with rationale. Both are versioned as commits.

**Heartbeat** — A periodic check-in where Alice reviews market conditions and decides whether to send you a message. Uses a structured protocol: `HEARTBEAT_OK` (nothing to report), `CHAT_YES` (has something to say), `CHAT_NO` (quiet).

**EventLog** — A persistent append-only JSONL event bus. Cron fires, heartbeat results, and errors all flow through here. Supports real-time subscriptions and crash recovery.

**Evolution Mode** — A permission escalation toggle. Off: Alice can only read/write `runtime/brain/`. On: full project access including Bash — Alice can modify her own source code.

## Architecture

```mermaid
graph LR
  subgraph Providers
    CC[Claude Code CLI]
    VS[Vercel AI SDK]
  end

  subgraph Core
    PR[ProviderRouter]
    AC[AgentCenter]
    E[Engine]
    TC[ToolCenter]
    S[Session Store]
    EL[Event Log]
    CR[Connector Registry]
  end

  subgraph Domains
    OBB[OpenTypeBB Data]
    IK[Indicator Kit]
    IT[Indicator Tools]
    BPA[Brooks PA]
    TR[Trading]
    GD[Guards]
    NC[News Collector]
    BR[Brain]
  end

  subgraph Tasks
    CRON[Cron Engine]
    HB[Heartbeat]
  end

  subgraph Interfaces
    WEB[Web UI]
    TG[Telegram]
    HTTP[HTTP API]
    MCP[MCP Server]
  end

  CC --> PR
  VS --> PR
  PR --> AC
  AC --> E
  E --> S
  TC -->|Vercel tools| VS
  TC -->|MCP tools| MCP
  OBB --> IK
  OBB --> NC
  IK --> IT
  IT --> TC
  IT --> BPA
  TR --> TC
  GD --> TR
  NC --> TC
  BR --> TC
  CRON --> EL
  HB --> CRON
  EL --> CRON
  CR --> WEB
  CR --> TG
  WEB --> E
  TG --> E
  HTTP --> E
  MCP --> E
```

**Providers** — interchangeable AI backends. Claude Code spawns `claude -p` as a subprocess; Vercel AI SDK runs an in-process tool loop. `ProviderRouter` reads `ai-provider.json` on each call to select the active backend at runtime.

**Core** — `Engine` is a thin facade that delegates to `AgentCenter`, which routes all calls (both stateless and session-aware) through `ProviderRouter`. `ToolCenter` is a centralized tool registry — domain modules register tools there, and it exports them in Vercel AI SDK and MCP formats. `EventLog` provides persistent append-only event storage (JSONL) with real-time subscriptions and crash recovery. `ConnectorCenter` tracks which channel the user last spoke through and handles delivery.

**Domains** — domain-specific tool sets registered in `ToolCenter`, grouped under cognition, research, technical analysis, and trading. `Guards` enforce pre-execution safety checks (position size limits, trade cooldowns, symbol whitelist) on all trading operations. `NewsCollector` runs background RSS fetches and piggybacks OpenTypeBB news calls into a persistent archive searchable by the agent.

**Tasks** — scheduled background work. `CronEngine` manages jobs and fires `cron.fire` events into the EventLog on schedule; a listener picks them up, runs them through the AI engine, and delivers replies via the ConnectorCenter. `Heartbeat` is a periodic health-check that uses a structured response protocol (HEARTBEAT_OK / CHAT_NO / CHAT_YES).

**Interfaces** — external surfaces. Web UI for local chat, Telegram bot for mobile, HTTP for webhooks, MCP server for tool exposure. External agents can also [converse with Alice via a separate MCP endpoint](docs/mcp-ask-connector.md).

## Quick Start

Prerequisites: Node.js 22+, pnpm 10+, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

```bash
git clone https://github.com/TraderAlice/OpenAlice.git
cd OpenAlice
pnpm install && pnpm build
pnpm dev
```

Open [localhost:3002](http://localhost:3002) and start chatting. No API keys or config needed — the default setup uses Claude Code as the AI backend with your existing login.

```bash
pnpm dev        # start backend (port 3002) with watch mode
pnpm dev:web    # start frontend dev server (port 5173) with hot reload
pnpm build      # production build (backend + UI)
pnpm test       # run tests
```

> **Note:** Port 3002 serves the Web UI only after `pnpm build`. For frontend development, use `pnpm dev:web` (port 5173) which proxies to the backend and provides hot reload.

## Configuration

All config lives in `config/` as JSON files with Zod validation. Missing files fall back to sensible defaults. You can edit these files directly or use the Web UI.

**AI Provider** — The default provider is Claude Code (`claude -p` subprocess). To use the [Vercel AI SDK](https://sdk.vercel.ai/docs) instead (Anthropic, OpenAI, Google, etc.), switch `ai-provider.json` to `vercel-ai-sdk` and add your API keys in that same file.

**Trading** — Multi-account architecture. Crypto via [CCXT](https://docs.ccxt.com/) (Bybit, OKX, Binance, etc.) configured in `crypto.json`. US equities via [Alpaca](https://alpaca.markets/) configured in `securities.json`. Both use the same git-like trading workflow.

| File | Purpose |
|------|---------|
| `engine.json` | Trading pairs, tick interval, timeframe |
| `agent.json` | Max agent steps, evolution mode toggle, Claude Code tool permissions |
| `ai-provider.json` | Active AI provider, model, base URL, and API keys |
| `crypto.json` | CCXT exchange config + API keys, allowed symbols, guards |
| `securities.json` | Alpaca broker config + API keys, allowed symbols, guards |
| `connectors.json` | Web/MCP server ports, Telegram bot credentials + enable, MCP Ask enable |
| `opentypebb.json` | OpenTypeBB SDK defaults and provider API keys |
| `news-collector.json` | RSS feeds, fetch interval, retention period, OpenTypeBB piggyback toggle |
| `compaction.json` | Context window limits, auto-compaction thresholds |
| `heartbeat.json` | Heartbeat enable/disable, interval, active hours |

Persona and heartbeat prompts use a **default + user override** pattern:

| Default (git-tracked) | User override (gitignored) |
|------------------------|---------------------------|
| `defaults/prompts/persona.md` | `runtime/brain/persona.md` |
| `defaults/prompts/heartbeat.md` | `runtime/brain/heartbeat.md` |

On first run, defaults are auto-copied to the user override path. Edit the user files to customize without touching version control.

## Project Structure

```
src/
  main.ts                    # Composition root — wires everything together
  core/
    engine.ts                # Thin facade, delegates to AgentCenter
    agent-center.ts          # Centralized AI agent management, owns ProviderRouter
    ai-provider.ts           # AIProvider interface + ProviderRouter (runtime switching)
    tool-center.ts           # Centralized tool registry (Vercel + MCP export)
    session.ts               # JSONL session store + format converters
    compaction.ts            # Auto-summarize long context windows
    config.ts                # Zod-validated config loader
    event-log.ts             # Persistent append-only event log (JSONL)
    connector-center.ts      # Last-interacted channel tracker + connector delivery
    media.ts                 # MediaAttachment extraction from tool outputs
    types.ts                 # Plugin, EngineContext interfaces
  ai-providers/
    claude-code/             # Claude Code CLI subprocess wrapper
    codex-cli/               # Codex CLI subprocess wrapper
    vercel-ai-sdk/           # Vercel AI SDK provider wrapper
  domains/
    cognition/
      brain/                 # Cognitive state (memory, emotion)
      thinking-kit/          # Reasoning and calculation tools
    research/
      equity/                # Equity fundamentals and data adapter
      market/                # Unified symbol search across equity, crypto, currency
      news/                  # OpenTypeBB news tools (world + company headlines)
      news-collector/        # RSS collector, piggyback wrapper, archive search tools
    technical-analysis/
      indicator-kit/         # Indicator formulas + OHLCV fetch strategies (library)
      indicator-tools/       # Indicator tool surface (calculateIndicator)
      brooks-pa/             # Brooks price action analysis tool
      ict-smc/               # ICT / SMC market-structure analysis tools
    trading/                 # Unified multi-account trading (CCXT + Alpaca), guard pipeline, git-like commit history
  integrations/
    opentypebb/
      sdk/                   # In-process OpenTypeBB executor + SDK client adapters
      equity/                # OpenTypeBB-backed equity data layer (price, fundamentals, estimates, etc.)
      crypto/                # OpenTypeBB-backed crypto data layer
      currency/              # OpenTypeBB-backed currency data layer
      commodity/             # OpenTypeBB-backed commodity data layer (EIA, spot prices)
      economy/               # OpenTypeBB-backed macro economy data layer
      news/                  # OpenTypeBB-backed news data layer
  connectors/
    web/                     # Web UI chat (Hono, SSE push)
    telegram/                # Telegram bot (grammY, polling, commands)
    mcp-ask/                 # MCP Ask connector (external agent conversation)
  jobs/
    cron/                    # Cron scheduling (engine, listener, AI tools)
    heartbeat/               # Periodic heartbeat with structured response protocol
  skills/                    # Agent skill definitions (Claude Code-style SKILL.md files)
  runtime/
    brain/                   # Cognitive state and user-overridden prompts
    sessions/                # JSONL conversation histories
    strategies/              # Strategy YAML files and scheduled job state
  config/                    # JSON configuration files
  defaults/                  # Factory defaults (prompts, bundled skills)
  brain/                     # Agent memory and emotion logs
  cache/                     # API response caches
  trading/                   # Trading commit history (per-account)
  news-collector/            # Persistent news archive (JSONL)
  cron/                      # Cron job definitions (jobs.json)
  event-log/                 # Persistent event log (events.jsonl)
docs/                        # Architecture documentation
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=TraderAlice/OpenAlice&type=Date)](https://star-history.com/#TraderAlice/OpenAlice&Date)

## License

[AGPL-3.0](LICENSE)
