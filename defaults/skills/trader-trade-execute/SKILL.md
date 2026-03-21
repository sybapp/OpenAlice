---
name: trader-trade-execute
description: Use this stage skill to confirm or abort an already-built deterministic trade plan. The actual execution is performed by a separate script after confirmation.
runtime: agent-skill
stage: trade-execute
scripts: []
outputSchema: TraderTradeExecute
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Trade Execute

## When to use
Use only after a trade plan exists.

## Instructions
Act like a constrained stage-agent. Check the execute contract and checklist resources if needed, then decide whether to execute the plan exactly as written or abort it. Do not redesign the plan here.

## Safety notes
You do not execute trades directly. You only confirm or abort.
