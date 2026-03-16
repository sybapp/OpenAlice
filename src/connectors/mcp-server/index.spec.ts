import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
  getMcpTools: vi.fn(async () => ({})),
  createMcpCapabilityTools: vi.fn(async () => ({})),
  honoFetch: vi.fn(),
}))

vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}))

vi.mock('hono', () => ({
  Hono: class {
    fetch = mocks.honoFetch
    use() {}
    all() {}
  },
}))

vi.mock('hono/cors', () => ({
  cors: () => async (_c: unknown, next: () => Promise<void>) => { await next() },
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool() {}
    async connect() {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: class {
    async handleRequest() {
      return new Response(null, { status: 200 })
    }
  },
}))

vi.mock('../../core/capabilities.js', () => ({
  createMcpCapabilityTools: mocks.createMcpCapabilityTools,
}))

const { McpServerConnector } = await import('./index.js')

describe('McpServerConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.serve.mockReset()
    mocks.getMcpTools.mockReset().mockResolvedValue({})
    mocks.createMcpCapabilityTools.mockReset().mockResolvedValue({})
  })

  it('rolls back to the previous listener when restart fails', async () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    mocks.serve
      .mockReturnValueOnce({ close: closeA })
      .mockImplementationOnce(() => {
        throw new Error('port busy')
      })
      .mockReturnValueOnce({ close: closeB })

    const plugin = new McpServerConnector({ getMcpTools: mocks.getMcpTools } as never, {
      host: '127.0.0.1',
      port: 3401,
    })
    const ctx = { toolCenter: {}, connectorCenter: {}, config: {}, engine: {} } as never

    await plugin.start(ctx)

    await expect(plugin.reconfigure({ host: '127.0.0.1', port: 3402 })).rejects.toThrow('port busy')
    expect(closeA).toHaveBeenCalledOnce()
    expect(plugin.getConfig()).toEqual({ host: '127.0.0.1', port: 3401 })
    expect(mocks.serve).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ hostname: '127.0.0.1', port: 3401, fetch: expect.any(Function) }),
      expect.any(Function),
    )

    await expect(plugin.reconfigure({ host: '127.0.0.1', port: 3401 })).resolves.toBe('unchanged')
    expect(closeB).not.toHaveBeenCalled()
  })

  it('restarts an unchanged listener when the server is no longer running', async () => {
    const closeA = vi.fn()
    mocks.serve
      .mockReturnValueOnce({ close: closeA })
      .mockReturnValueOnce({ close: vi.fn() })

    const plugin = new McpServerConnector({ getMcpTools: mocks.getMcpTools } as never, {
      host: '127.0.0.1',
      port: 3403,
    })
    const ctx = { toolCenter: {}, connectorCenter: {}, config: {}, engine: {} } as never

    await plugin.start(ctx)
    await plugin.stop()

    await expect(plugin.reconfigure({ host: '127.0.0.1', port: 3403 })).resolves.toBe('restarted')
    expect(closeA).toHaveBeenCalledOnce()
    expect(mocks.serve).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1', port: 3403, fetch: expect.any(Function) }),
      expect.any(Function),
    )
  })
})
