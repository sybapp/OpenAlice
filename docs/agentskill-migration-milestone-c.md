# Milestone C: AgentSkill-Native Application Services

Milestone C builds on Milestones A and B by pushing AgentSkill ownership into higher-level product behavior instead of leaving skill invocation as ad hoc engine plumbing inside product flows.

## Goal

Make product behavior depend on explicit AgentSkill-native application services rather than repeating low-level session-skill setup, engine ask wiring, structured completion parsing, and loop-trace extraction in each feature slice.

In this repo, that means:

1. higher-level flows invoke skills through a shared AgentSkill application service
2. structured completion parsing and loop-trace reading are centralized instead of copied into trader/backtest flows
3. product entrypoints consume AgentSkill-native contracts while provider/router mechanics stay underneath the engine/runtime boundary

## Milestone C plan followed

1. Identify higher-level flows that manually perform AgentSkill invocation lifecycle work
2. Extract a shared `src/skills/service.ts` application service for invoking and parsing AgentSkill calls
3. Move trader stage execution, MCP skill capability execution, and trader backtest stages onto that service
4. Add focused regressions for forwarded runtime options, trace extraction, and wrapped structured completions
5. Validate the affected slices and confirm no meaningful duplicated AgentSkill invocation path remains in product code

## Outcome

Milestone C is complete for this target slice.

The project now has:
- a shared AgentSkill application service that owns session-skill activation, structured completion parsing, and trace extraction
- trader workflow stages, MCP-exposed skill capabilities, and trader backtest stages consuming that service instead of hand-rolled engine plumbing
- higher-level product behavior depending on AgentSkill-native service contracts rather than repeated provider/runtime mechanics

## Next after Milestone C

The next campaign should move from shared invocation into fuller skill package ownership, such as:
- introducing an explicit project-level skill catalog/application facade for user-invocable skills, capability exposure, and package metadata
- narrowing direct registry/script-registry coupling in commands and capability inventory
- clarifying how skill resources/scripts are surfaced to product features without each feature rebuilding its own view
