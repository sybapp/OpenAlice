# Milestone D: Skill Package Ownership Facade

Milestone D completes the remaining high-level migration seam by moving product-facing skill package ownership behind explicit catalog and script-service boundaries.

## Goal

Make higher-level product features depend on project-level skill contracts instead of reading raw skill registries and script registries directly.

In this repo, that means:

1. commands and capability inventory consume a shared skill catalog facade
2. MCP skill exposure comes from that shared skill catalog instead of ad hoc registry filtering
3. higher-level product flows execute named skill scripts through a shared script service instead of direct script-registry lookups

## Outcome

Milestone D is complete for this target slice.

The project now has:
- `src/skills/catalog.ts` as the project-level skill package/catalog facade for product-facing inventory and manual skill selection
- `src/skills/script-service.ts` as the shared named-script execution boundary
- commands, capability inventory, MCP skill exposure, trader orchestration, and skill-loop script execution relying on explicit skill services instead of direct registry coupling

## Completion review

With Milestones A-D complete, the broader OpenAlice -> OpenClaw/AgentSkill migration is complete for this repo target.

Remaining direct `registry` / `script-registry` usage is intentionally confined to lower-level skill/provider infrastructure and tests, which is the desired ownership boundary.
