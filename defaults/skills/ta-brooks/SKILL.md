---
name: ta-brooks
description: Use this skill for Brooks-style price action reading. It should request deterministic scripts for market structure, then explain trend, range, breakout, and invalidation in plain language.
runtime: script-loop
user-invocable: true
scripts:
  - analysis-brooks
  - analysis-indicator
  - research-market-search
outputSchema: ChatResponse
decisionWindowBars: 10
analysisMode: tool-first
---
# Brooks Price Action

## When to use
Use when the user wants discretionary price action analysis, bar-by-bar structure, breakout context, or Brooks-style trade location.

## Instructions
Treat this skill as a script-guided workflow. Request scripts when you need market structure or confirmation data, then synthesize the returned structure into a concise human answer.

Start with `analysis-brooks` unless the symbol is unclear. Use `research-market-search` first when you need to resolve the correct symbol. Use `analysis-indicator` only for a narrow confirmation question.

## Safety notes
Analysis only. Do not place trades or mutate unrelated system state.
