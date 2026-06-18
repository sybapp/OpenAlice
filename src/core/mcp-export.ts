/**
 * MCP Export — shared bridge from Vercel AI SDK tools to MCP format.
 *
 * Used by `src/server/mcp.ts` (the external MCP server workspaces connect to).
 *
 * Handles:
 * - Zod shape extraction with number coercion (MCP clients may send "80" instead of 80)
 * - Tool result → MCP content block conversion
 * - Execute wrapper (try/catch + toolCallId generation)
 */

import { z } from 'zod'
import type { Tool } from 'ai'

// ==================== Types ====================

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export type McpToolResult = {
  content: McpContent[]
  isError?: boolean
}

// ==================== Result conversion ====================

/**
 * Convert a Vercel AI SDK tool result to MCP content blocks.
 *
 * If the result has a `.content` array (the multi-modal AgentToolResult
 * shape — `{ content: [{type:"text",...}|{type:"image",...}, ...] }`),
 * map each item to native MCP text/image blocks. This avoids stringify-ing
 * base64 image data into a giant JSON text blob.
 *
 * Otherwise, fall back to JSON.stringify.
 */
export function toMcpContent(result: unknown): McpContent[] {
  if (
    result != null &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const items = (result as { content: Array<Record<string, unknown>> }).content
    const blocks: McpContent[] = []
    for (const item of items) {
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      } else if (item.type === 'text' && typeof item.text === 'string') {
        blocks.push({ type: 'text', text: item.text })
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(item) })
      }
    }
    if ('details' in result && (result as { details: unknown }).details != null) {
      blocks.push({ type: 'text', text: JSON.stringify((result as { details: unknown }).details) })
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: JSON.stringify(result) }]
  }
  return [{ type: 'text', text: JSON.stringify(result) }]
}

// ==================== Schema coercion ====================

/**
 * If the schema is a Zod v4 number/boolean type (possibly wrapped in optional),
 * return a coerced copy that accepts string values from CLI/MCP clients.
 * Preserves all refinements (int, positive, min, max, nonnegative).
 *
 * This is the MCP boundary adaptation: tool definitions stay strict,
 * but MCP clients that send "80" instead of 80 won't be rejected.
 */
function coerceBoundaryScalar(schema: z.ZodType): z.ZodType {
  const def = (schema as any)._zod?.def
  if (!def) return schema

  // z.number() / z.number().int().positive() etc.
  if (def.type === 'number' && !def.coerce) {
    let coerced: any = z.coerce.number()
    if (def.checks?.length > 0) coerced = coerced.with(...def.checks)
    return coerced
  }

  if (def.type === 'boolean' && !def.coerce) {
    return z.preprocess((value) => {
      if (typeof value !== 'string') return value
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
      return value
    }, z.boolean())
  }

  // z.number().optional()
  if (def.type === 'optional' && def.innerType?._zod?.def?.type === 'number' && !def.innerType._zod.def.coerce) {
    let coerced: any = z.coerce.number()
    const innerChecks = def.innerType._zod.def.checks
    if (innerChecks?.length > 0) coerced = coerced.with(...innerChecks)
    return coerced.optional()
  }

  if (def.type === 'optional' && def.innerType?._zod?.def?.type === 'boolean' && !def.innerType._zod.def.coerce) {
    return z.preprocess((value) => {
      if (typeof value !== 'string') return value
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
      return value
    }, z.boolean()).optional()
  }

  return schema
}

/**
 * Extract the Zod raw shape from a Vercel AI SDK tool's inputSchema,
 * applying number coercion for MCP boundary safety.
 */
export function extractMcpShape(tool: Tool): Record<string, z.ZodType> {
  const rawShape: Record<string, z.ZodType> = (tool.inputSchema as any)?.shape ?? {}
  const coerced: Record<string, z.ZodType> = {}
  for (const [key, schema] of Object.entries(rawShape)) {
    coerced[key] = coerceBoundaryScalar(schema)
  }
  return coerced
}

/**
 * Build the strict Zod object used to validate tool input at the MCP / CLI /
 * webui boundary.
 *
 * ⚠️ BEHAVIOR CHANGE (breaking-ish): `.strict()` REJECTS unknown keys, and as
 * of the market-data service work this schema gates EVERY tool's execute path
 * (see `wrapToolExecute`) — not just market-data tools. Callers that used to
 * pass extra/undeclared fields and have them silently ignored now get a
 * validation error. This is intentional hardening (tool input shapes stay
 * authoritative), but any MCP/CLI client relying on extra-key tolerance must
 * be updated.
 *
 * Caveat: only the field-level `.shape` is carried over here; object-level
 * refinements (`.refine` / `.superRefine`) on a tool's inputSchema are NOT
 * reconstructed. No current tool uses them — new tools must not depend on
 * object-level refinements for boundary validation.
 */
export function mcpInputSchema(tool: Tool): z.ZodObject<Record<string, z.ZodType>> {
  return z.object(extractMcpShape(tool)).strict()
}

export function formatZodError(err: unknown): string {
  return err instanceof z.ZodError ? z.prettifyError(err) : String(err)
}

// ==================== Execute wrapper ====================

/**
 * Wrap a Vercel AI SDK tool's execute function for MCP consumption.
 * Adds try/catch error handling and toolCallId generation.
 */
export function wrapToolExecute(tool: Tool): (args: any) => Promise<McpToolResult> {
  return async (args: any) => {
    try {
      // Validate + coerce at the boundary. NOTE: strict — unknown keys are
      // rejected for ALL tools (see mcpInputSchema). This is a behavior change
      // vs the pre-market-data path, which passed raw args straight to execute.
      const validated = await mcpInputSchema(tool).parseAsync(args ?? {})
      const result = await tool.execute!(validated, {
        toolCallId: crypto.randomUUID(),
        messages: [],
      })
      return { content: toMcpContent(result) }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err}` }],
        isError: true,
      }
    }
  }
}
