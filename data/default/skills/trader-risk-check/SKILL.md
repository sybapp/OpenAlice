---
name: trader-risk-check
description: Use this stage skill to decide whether a thesis can proceed under the strategy risk budget and current account exposure.
runtime: script-loop
stage: risk-check
scripts:
  - trader-account-state
outputSchema: TraderRiskCheck
decisionWindowBars: 10
analysisMode: tool-first
---
# Trader Risk Check

## When to use
Use only after a trade thesis exists.

## Instructions
Use fresh account state and the strategy risk card to decide pass, fail, or reduce. Be conservative when exposure is already stretched.

## Safety notes
Do not create or execute orders in this stage.
