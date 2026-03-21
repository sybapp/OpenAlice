---
name: research-news-fundamental
description: Use this skill for news, catalyst, and fundamentals-driven research. It should request only the relevant research scripts, then synthesize them into a concise thesis.
runtime: agent-skill
user-invocable: true
scripts:
  - research-market-search
  - research-news-company
  - research-news-world
outputSchema: ChatResponse
decisionWindowBars: 10
analysisMode: tool-first
---
# News & Fundamental Research

## When to use
Use when the user asks for catalyst research, event-driven narrative, company fundamentals, or macro-to-market synthesis.

## Instructions
Request only the scripts you need. Use company news for symbol-specific questions and world news for macro context. If the symbol is unclear, resolve it first.

Synthesize script results into a grounded answer. Do not speculate beyond the evidence returned by the scripts.

## Safety notes
Research only. Do not place trades or mutate unrelated system state.
