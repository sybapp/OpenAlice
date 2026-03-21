---
name: ta-ict-smc
description: Use this skill for ICT or SMC framing. It should request structure scripts, then explain liquidity, FVGs, BOS, CHOCH, premium/discount, and invalidation.
runtime: agent-skill
user-invocable: true
scripts:
  - analysis-ict-smc
  - analysis-indicator
  - research-market-search
outputSchema: ChatResponse
decisionWindowBars: 10
analysisMode: tool-first
---
# ICT / SMC Structure

## When to use
Use when the user wants ICT/SMC structure analysis, liquidity framing, imbalance context, BOS/CHOCH reading, or premium/discount narrative.

## Instructions
Request deterministic scripts first. Start with `analysis-ict-smc` unless the symbol is unclear. Use `research-market-search` when you need to resolve symbols. Use `analysis-indicator` only when it sharpens the structure read.

Summarize the returned structure in ICT/SMC terms and keep the explanation grounded in the script output.

## Safety notes
Analysis only. Do not place trades or mutate unrelated system state.
