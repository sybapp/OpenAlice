---
name: trader-trade-thesis
description: Use this stage skill to request analysis or research scripts for one candidate symbol, then produce a structured trade thesis with scenario, bias, rationale, and invalidation.
runtime: script-loop
stage: trade-thesis
scripts:
  - trader-account-state
  - analysis-brooks
  - analysis-ict-smc
  - analysis-indicator
  - research-news-company
  - research-news-world
  - research-equity-profile
  - research-equity-financials
  - research-equity-ratios
  - research-equity-estimates
outputSchema: TraderTradeThesis
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Trade Thesis

## When to use
Use only after market scan has selected a candidate symbol.

## Instructions
Request only the scripts required to explain the setup. Produce one thesis for one symbol and prefer no-trade when structure or catalyst context is mixed.

## Safety notes
Do not propose orders in this stage.
