---
name: ta-brooks-ict-smc
description: Use this skill for confluence analysis between Brooks price action and ICT/SMC structure. It should request both structure scripts, then explain where the frameworks agree or conflict.
runtime: script-loop
user-invocable: true
scripts:
  - analysis-brooks
  - analysis-ict-smc
  - analysis-indicator
  - research-market-search
outputSchema: ChatResponse
decisionWindowBars: 10
analysisMode: tool-first
---
# Brooks + ICT / SMC Confluence

## When to use
Use when the user wants a single narrative that combines Brooks-style market reading with liquidity-structure analysis.

## Instructions
Use the script loop. Resolve the symbol if needed, then request both `analysis-brooks` and `analysis-ict-smc`. Highlight agreement, disagreement, and what would invalidate the current read. Use `analysis-indicator` only for small confirmation checks.

## Safety notes
Analysis only. Do not place trades or mutate unrelated system state.
