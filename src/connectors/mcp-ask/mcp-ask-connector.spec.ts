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

  it('waits for the listener to finish closing before stop resolves', async () => {
    let closeCallback: ((err?: Error) => void) | undefined
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    mocks.serve.mockReturnValue({
      close: vi.fn((callback?: (err?: Error) => void) => {
        closeCallback = callback
      }),
    })

    const plugin = new McpAskConnector({ port: 3105, authToken: 'secret' })
    await plugin.start({
      connectorCenter: { register },
      engine: {},
    } as never)

    let stopped = false
    const stopPromise = plugin.stop().then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(unregister).toHaveBeenCalledOnce()

    closeCallback?.()
    await stopPromise

    expect(stopped).toBe(true)
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
