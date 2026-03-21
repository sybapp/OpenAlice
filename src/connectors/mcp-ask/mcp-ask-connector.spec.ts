import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { SessionStore } from '../../core/session.js'
import { RUNTIME_SESSIONS_DIR } from '../../core/paths.js'

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
  tools: [] as Array<{ name: string; handler: (args: any) => Promise<any> }>,
}))

vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
      mocks.tools.push({ name, handler })
    }

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

const { McpAskConnector } = await import('./index.js')

describe('McpAskConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tools.length = 0
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
      runtimeCatalog: { interactive: {}, providerOnlyJob: {}, trader: {} },
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
      runtimeCatalog: { interactive: {}, providerOnlyJob: {}, trader: {} },
    } as never)).rejects.toThrow('port busy')

    expect(register).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('lists persisted sessions from the runtime sessions directory', async () => {
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    let fetchHandler: ((request: Request) => Promise<Response> | Response) | undefined
    mocks.serve.mockReturnValue({
      close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
    })
    mocks.serve.mockImplementation((options: { fetch: (request: Request) => Promise<Response> | Response }) => {
      fetchHandler = options.fetch
      return {
        close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
      }
    })

    const sessionId = `list-${randomUUID()}`
    const session = new SessionStore(`mcp-ask__${sessionId}`)
    await session.appendUser('hello', 'human')

    const plugin = new McpAskConnector({ port: 3105, authToken: 'secret' })

    try {
      await plugin.start({
        connectorCenter: { register },
        engine: {},
      runtimeCatalog: { interactive: {}, providerOnlyJob: {}, trader: {} },
      } as never)

      expect(fetchHandler).toBeDefined()
      await fetchHandler!(new Request('http://localhost:3105/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      }))

      const listSessions = mocks.tools.find((tool) => tool.name === 'listSessions')
      expect(listSessions).toBeDefined()

      const result = await listSessions!.handler({})
      const payload = JSON.parse(result.content[0].text) as { sessions: Array<{ sessionId: string }> }

      expect(payload.sessions).toContainEqual({ sessionId })
    } finally {
      await plugin.stop()
      await unlink(`${RUNTIME_SESSIONS_DIR}/mcp-ask__${sessionId}.jsonl`).catch(() => undefined)
    }
  })
})
