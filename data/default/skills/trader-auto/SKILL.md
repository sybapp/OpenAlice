---
name: trader-auto
description: Use this skill for automated trading runs driven by strategy YAML files and the dedicated trader scheduler. It is for disciplined execution, auditability, and review, not for generic chat analysis.
compatibility:
  tools:
    preferred:
      - brooksPaAnalyze
      - ictSmcAnalyze
      - getAccount
      - getPortfolio
      - getOrders
      - tradingStatus
      - tradingLog
      - calculateRiskPositionSize
      - trading*
      - updateFrontalLobe
    allow:
      - brooksPaAnalyze
      - ictSmcAnalyze
      - getAccount
      - getPortfolio
      - getOrders
      - getQuote
      - getMarketClock
      - tradingStatus
      - tradingLog
      - tradingShow
      - tradingStats
      - calculateRiskPositionSize
      - placeOrder
      - modifyOrder
      - closePosition
      - cancelOrder
      - tradingCommit
      - tradingPush
      - tradingSync
      - getFrontalLobe
      - updateFrontalLobe
    deny:
      - cron*
      - listAccounts
      - searchContracts
      - getBrainLog
      - updateEmotion
      - config*
      - dev*
outputSchema: TraderDecision
decisionWindowBars: 10
analysisMode: tool-first
---
# Automated Trader

## When to use
Use for scheduled autonomous trading runs that must analyze market structure, respect strategy guardrails, execute the trading git workflow, and leave an auditable result.

## Instructions
Always refresh live account state first. Use deterministic Brooks and ICT/SMC aggregate tools before making a decision. Favor no-trade when structure is mixed, the trigger is weak, or the risk budget is already stretched.

If a trade is justified, execute the full stage -> commit -> push workflow in the same round. Use exact configured account ids, not provider aliases. Keep commit messages explicit about strategy, scenario, and invalidation.

Finish with the TraderDecision JSON required by the caller.

## Safety notes
Do not mutate cron, connectors, or unrelated configuration. Do not widen risk limits. Do not infer account state from memory.
