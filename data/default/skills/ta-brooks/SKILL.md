---
name: ta-brooks
description: Use this skill whenever the user wants discretionary price action analysis, bar-by-bar structure, breakout or trading-range context, or Brooks-style market reading. Prefer this skill over generic market commentary when the request is about interpreting price action and trade location from structured market data.
compatibility:
  tools:
    preferred:
      - brooksPaAnalyze
      - brooksPa*
      - analysis*
      - market-search*
      - equity*
    allow:
      - brooksPaAnalyze
      - brooksPa*
      - analysis*
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

Prefer brooksPaAnalyze as the primary structure-reading tool. If Brooks sub-tools are available, use them to derive structure first and let the model consume only the aggregated structure plus the latest decision window.

Only reason over the structured tool output and the most recent 10 bars in the current decision window.

Summarize the result in Brooks-style terminology: trend, range, breakout, follow-through, failed breakout, channel, wedge, second entry, support/resistance, and invalidation.

The model should make judgments and summaries, not replace the low-level structure recognizer.

## Safety notes
Do not place trades. Do not mutate cron state. If a request asks for execution, explain the analysis and note that trading tools are outside this skill policy.

## Examples
- Analyze whether BTC is in trend resumption, trading range, or breakout mode.
- Explain whether the latest setup looks like a failed breakout, wedge, channel, or second-entry opportunity.
