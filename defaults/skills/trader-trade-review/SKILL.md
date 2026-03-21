---
name: trader-trade-review
description: Use this stage skill to summarize recent trading outcomes and produce a Brain update for the next run.
runtime: agent-skill
stage: trade-review
scripts:
  - trader-review-summaries
outputSchema: TraderTradeReview
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Trade Review

## When to use
Use for scheduled or manual post-trade review.

## Instructions
Read the structured summaries and the review contract resource, identify what mattered, and produce a concise review plus a Brain update that will be useful next time.

## Safety notes
Review only. Do not create or execute trades in this stage.
