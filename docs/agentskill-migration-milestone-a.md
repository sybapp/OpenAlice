# Milestone A: Engine Runtime Boundary

OpenAlice is moving toward an OpenClaw/AgentSkill-native runtime model where session execution is an explicit pipeline rather than a hybrid engine with embedded special cases.

## Target model

For session-based execution, the runtime boundary is:

1. `local-command` handlers
2. `agent-skill` handlers
3. `provider-route` handlers

Each step receives the same session request contract and may either:
- decline and pass control onward, or
- terminate the request with a concrete result/stream.

## Why this matters

Before this slice, `Engine` directly knew about:
- slash/local commands
- legacy script-loop / canonical agent-skill execution
- provider fallback

That made the core runtime feel like a hybrid with one special skill-loop side path.

After this slice:
- `Engine` owns orchestration of a session runtime pipeline
- local command handling is one runtime step
- AgentSkill execution is one runtime step
- provider routing is the terminal runtime step
- bootstrap decides the concrete pipeline composition

## Milestone A status

Milestone A is complete for its target boundary. The project now has:
- an explicit session runtime pipeline in `Engine`
- canonical `agent-skill` runtime terminology and metadata
- a shared runtime catalog that names the main runtime profiles (`interactive`, `providerOnlyJob`, `trader`)
- higher-level entrypoints selecting runtime profiles explicitly instead of depending on the default interactive engine by convention

## Next after Milestone A

The next migration work should move beyond runtime-boundary cleanup into broader project-native adoption, including:
- reducing remaining provider-specific assumptions in higher-level product flows
- continuing to migrate skill registry/runtime metadata toward project-wide ownership boundaries
- expanding explicit AgentSkill-native contracts beyond the current runtime composition layer
