# Milestone B: Backend-Agnostic Product Flows

Milestone B builds on Milestone A's explicit runtime boundaries by pushing provider- and backend-specific assumptions out of higher-level product flows.

## Goal

Make higher-level application behavior depend on explicit project contracts rather than scattered provider-specific branches.

In this repo, that means:

1. product flows use the shared runtime catalog instead of calling backend-specific helpers directly
2. backend selection metadata comes from a shared catalog instead of repeated string literals and label maps
3. provider-specific logic stays in the provider layer and router, not in commands, connectors, or product routes

## Milestone B plan followed

1. Identify direct provider-specific product-flow assumptions
2. Replace the `/compact` command's Claude-specific summarization path with runtime-catalog provider routing
3. Extract a shared backend catalog for backend ids, labels, and validation
4. Move config and Telegram backend selection onto that shared catalog
5. Validate the affected flows and confirm no meaningful higher-level provider-specific assumptions remain

## Outcome

Milestone B is complete for its target slice.

The project now has:
- a shared runtime catalog for runtime/profile selection
- provider-agnostic compaction routed through the active interactive runtime
- a shared backend catalog for backend ids, labels, and validation
- backend-selection UI and config flows using shared backend contracts instead of duplicated provider-specific literals

## Next after Milestone B

The next campaign should move beyond backend-agnostic cleanup into deeper AgentSkill-native ownership, such as:
- pushing more product behavior into explicit skill-oriented contracts and reusable services
- shrinking residual provider/router assumptions inside lower-level infrastructure
- clarifying skill package/resource ownership boundaries beyond the current registry/runtime surfaces
