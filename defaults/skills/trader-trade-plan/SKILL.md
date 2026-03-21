---
name: trader-trade-plan
description: Use this stage skill to convert an approved thesis into a deterministic order plan and explicit commit message.
runtime: agent-skill
stage: trade-plan
scripts:
  - trader-account-state
outputSchema: TraderTradePlan
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Trade Plan

## When to use
Use only after risk-check passes.

## Instructions
Act like a constrained stage-agent. Check the plan contract and checklist resources if needed, gather the required fresh account evidence, and translate the thesis into a precise plan. Respect execution policy exactly. If no valid order plan fits the strategy, return skip.

## Safety notes
Do not execute the plan in this stage.
