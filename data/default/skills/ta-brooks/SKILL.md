---
name: ta-brooks
description: Use this skill whenever the user wants discretionary price action analysis, bar-by-bar structure, breakout or trading-range context, or Brooks-style market reading. Prefer this skill over generic market commentary when the request is about interpreting price action and trade location from structured market data.
compatibility:
  tools:
    preferred:
      - brooksPaAnalyze
      - market-search*
      - equity*
    allow:
      - brooksPaAnalyze
      - market-search*
      - equity*
    deny:
      - trading*
      - cronAdd
      - cronUpdate
      - cronRemove
      - cronRunNow
outputSchema: AnalysisReport
decisionWindowBars: 10
analysisMode: tool-first
---
# Brooks Price Action

## When to use
Use for price action, candle structure, trend-versus-range judgment, breakout follow-through, and Brooks-style trade narrative. This skill is for reading the market, not for placing orders.

## Instructions
Start with deterministic analysis tools instead of feeding long raw OHLCV sequences into the model.

Prefer `brooksPaAnalyze` as the single entry point. The tool returns **v2 layered output**:
- `core`: stable fields intended for trading decisions / programmatic use
- `detailed`: full deterministic breakdown intended for UI, debugging, and post-trade review

Default to `detailLevel: full` for human analysis. For automated/trading-mode decisions, prefer `detailLevel: core`.

Only reason over the tool output and the most recent decision-window bars included in the output. Do not reason over long raw bar history.

Summarize the result in Brooks-style terminology: trend, range, breakout, follow-through, failed breakout, channel, wedge, second entry, support/resistance, and invalidation.

## Safety notes
Do not place trades. Do not mutate cron state. If a request asks for execution, explain the analysis and note that trading tools are outside this skill policy.

## Examples
- Analyze whether BTC is in trend resumption, trading range, or breakout mode.
- Explain whether the latest setup looks like a failed breakout, wedge, channel, or second-entry opportunity.
