import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
}))

vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool() {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: class {
    async handleRequest() {
      return new Response(null, { status: 200 })
    }
  },
}))

const { McpAskConnector } = await import('./index.js')

describe('McpAskConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('unregisters the connector when listener startup fails after registration', async () => {
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    mocks.serve.mockImplementation(() => {
      throw new Error('port busy')
    })

    const plugin = new McpAskConnector({ port: 3105, authToken: 'secret' })

    await expect(plugin.start({
      connectorCenter: { register },
      engine: {},
    } as never)).rejects.toThrow('port busy')

    expect(register).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
  })
})
