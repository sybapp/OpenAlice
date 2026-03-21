---
name: trader-trade-thesis
description: Use this stage skill to request analysis or research scripts for one candidate symbol, then produce a structured trade thesis with scenario, bias, rationale, and invalidation.
runtime: agent-skill
stage: trade-thesis
scripts:
  - trader-account-state
  - analysis-brooks
  - analysis-ict-smc
  - analysis-indicator
  - research-news-company
  - research-news-world
outputSchema: TraderTradeThesis
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Trade Thesis

## When to use
Use only after market scan has selected a candidate symbol.

## Instructions
Act like a constrained stage-agent. Check the stage contract resource if needed, request the required evidence scripts for the nominated candidate, then produce one thesis for one symbol. Prefer no-trade when structure or catalyst context is mixed.

## Safety notes
Do not propose orders in this stage.
