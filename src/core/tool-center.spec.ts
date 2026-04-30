import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolCenter } from './tool-center.js'
import type { Tool } from 'ai'
import { z } from 'zod'

vi.mock('./config.js', () => ({
  readToolsConfig: vi.fn(),
}))

import { readToolsConfig } from './config.js'
const mockReadToolsConfig = vi.mocked(readToolsConfig)

// ==================== Helpers ====================

function makeTool(description = 'A test tool'): Tool {
  return { description, inputSchema: z.object({}), execute: async () => ({ ok: true }) } as unknown as Tool
}

function toolsConfig(disabled: string[] = []) {
  return {
    disabled,
    permission: { enabled: true, defaultAction: 'allow' as const, highRiskDefaultAction: 'deny' as const, audit: false, rules: [] },
  }
}

// ==================== ToolCenter ====================

describe('ToolCenter', () => {
  describe('register + list', () => {
    it('should register and list tool names', () => {
      const tc = new ToolCenter()
      tc.register({ alpha: makeTool(), beta: makeTool() }, 'group1')
      expect(tc.list().sort()).toEqual(['alpha', 'beta'])
    })

    it('should overwrite same-name tool on re-register', () => {
      const tc = new ToolCenter()
      tc.register({ alpha: makeTool('v1') }, 'group1')
      tc.register({ alpha: makeTool('v2') }, 'group2')
      expect(tc.list()).toEqual(['alpha'])
      const inv = tc.getInventory()
      expect(inv[0].group).toBe('group2')
      expect(inv[0].description).toBe('v2')
    })

    it('should handle multiple groups', () => {
      const tc = new ToolCenter()
      tc.register({ a: makeTool() }, 'g1')
      tc.register({ b: makeTool() }, 'g2')
      expect(tc.list().sort()).toEqual(['a', 'b'])
    })

    it('should return empty list when nothing registered', () => {
      const tc = new ToolCenter()
      expect(tc.list()).toEqual([])
    })
  })

  describe('getInventory', () => {
    it('should return name, group, and description', () => {
      const tc = new ToolCenter()
      tc.register({ myTool: makeTool('Does something') }, 'analysis')
      const inv = tc.getInventory()
      expect(inv).toEqual([
        { name: 'myTool', group: 'analysis', description: 'Does something' },
      ])
    })

    it('should truncate long descriptions to 200 chars', () => {
      const tc = new ToolCenter()
      const longDesc = 'x'.repeat(300)
      tc.register({ tool: makeTool(longDesc) }, 'g')
      const inv = tc.getInventory()
      expect(inv[0].description).toHaveLength(200)
    })

    it('should handle tools with no description', () => {
      const tc = new ToolCenter()
      tc.register({ tool: {} as Tool }, 'g')
      const inv = tc.getInventory()
      expect(inv[0].description).toBe('')
    })
  })

  describe('getVercelTools', () => {
    beforeEach(() => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig())
    })

    it('should return all tools when disabled list is empty', async () => {
      const tc = new ToolCenter()
      tc.register({ a: makeTool(), b: makeTool() }, 'g')
      const tools = await tc.getVercelTools()
      expect(Object.keys(tools).sort()).toEqual(['a', 'b'])
    })

    it('should exclude disabled tools from the result', async () => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig(['b']))
      const tc = new ToolCenter()
      tc.register({ a: makeTool(), b: makeTool(), c: makeTool() }, 'g')
      const tools = await tc.getVercelTools()
      expect(Object.keys(tools).sort()).toEqual(['a', 'c'])
    })

    it('should exclude all matching tools when multiple are disabled', async () => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig(['a', 'c']))
      const tc = new ToolCenter()
      tc.register({ a: makeTool(), b: makeTool(), c: makeTool() }, 'g')
      const tools = await tc.getVercelTools()
      expect(Object.keys(tools)).toEqual(['b'])
    })

    it('should not error when disabled list contains unknown tool names', async () => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig(['nonexistent']))
      const tc = new ToolCenter()
      tc.register({ a: makeTool() }, 'g')
      const tools = await tc.getVercelTools()
      expect(Object.keys(tools)).toEqual(['a'])
    })

    it('should return empty object when all tools are disabled', async () => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig(['a', 'b']))
      const tc = new ToolCenter()
      tc.register({ a: makeTool(), b: makeTool() }, 'g')
      const tools = await tc.getVercelTools()
      expect(Object.keys(tools)).toEqual([])
    })

    it('should return empty object when no tools are registered', async () => {
      const tc = new ToolCenter()
      const tools = await tc.getVercelTools()
      expect(tools).toEqual({})
    })
  })

  describe('getMcpTools', () => {
    beforeEach(() => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig())
    })

    it('should return same results as getVercelTools when disabled list is empty', async () => {
      const tc = new ToolCenter()
      tc.register({ x: makeTool(), y: makeTool() }, 'g')
      const vercel = await tc.getVercelTools()
      const mcp = await tc.getMcpTools()
      expect(Object.keys(mcp).sort()).toEqual(Object.keys(vercel).sort())
    })

    it('should apply disabled list filtering same as getVercelTools', async () => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig(['x']))
      const tc = new ToolCenter()
      tc.register({ x: makeTool(), y: makeTool() }, 'g')
      const tools = await tc.getMcpTools()
      expect(Object.keys(tools)).toEqual(['y'])
    })
  })

  describe('permissions', () => {
    beforeEach(() => {
      mockReadToolsConfig.mockResolvedValue(toolsConfig())
    })

    it('wraps high-risk tools and returns structured denial', async () => {
      const tc = new ToolCenter()
      tc.register({ placeOrder: makeTool('place') }, 'trading')

      const tools = await tc.getVercelTools({ sessionId: 's1', provider: 'test' })
      const result = await tools.placeOrder.execute!({}, { toolCallId: 't1', messages: [] })

      expect(result).toMatchObject({
        code: 'TOOL_PERMISSION_DENIED',
        tool: 'placeOrder',
      })
    })

    it('honors custom allow rules', async () => {
      mockReadToolsConfig.mockResolvedValue({
        disabled: [],
        permission: {
          enabled: true,
          defaultAction: 'allow',
          highRiskDefaultAction: 'deny',
          audit: false,
          rules: [{ action: 'allow', tools: ['placeOrder'] }],
        },
      })
      const tc = new ToolCenter()
      tc.register({ placeOrder: makeTool('place') }, 'trading')

      const tools = await tc.getVercelTools()
      const result = await tools.placeOrder.execute!({}, { toolCallId: 't1', messages: [] })

      expect(result).toEqual({ ok: true })
    })

    it('can disable permission engine', async () => {
      mockReadToolsConfig.mockResolvedValue({
        disabled: [],
        permission: { enabled: false, defaultAction: 'allow', highRiskDefaultAction: 'deny', audit: false, rules: [] },
      })
      const tc = new ToolCenter()
      tc.register({ readSession: makeTool('read') }, 'session')

      const tools = await tc.getVercelTools()
      const result = await tools.readSession.execute!({}, { toolCallId: 't1', messages: [] })

      expect(result).toEqual({ ok: true })
    })
  })
})
