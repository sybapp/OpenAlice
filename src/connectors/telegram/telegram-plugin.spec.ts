import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readAIConfig: vi.fn(),
  writeAIConfig: vi.fn(),
  autoRetry: vi.fn(() => 'auto-retry-middleware'),
  botInstances: [] as any[],
  Bot: class FakeBot {
    token: string
    botInfo = { username: 'alice_bot' }
    middlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = []
    commands = new Map<string, (ctx: any) => Promise<void>>()
    events = new Map<string, (ctx: any) => Promise<void>>()
    api = {
      config: { use: vi.fn() },
      setMyCommands: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendPhoto: vi.fn(async () => undefined),
      editMessageText: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    }
    constructor(token: string) {
      this.token = token
      mocks.botInstances.push(this)
    }
    use = vi.fn((fn: (ctx: any, next: () => Promise<void>) => Promise<void>) => {
      this.middlewares.push(fn)
      return this
    })
    command = vi.fn((name: string, fn: (ctx: any) => Promise<void>) => {
      this.commands.set(name, fn)
      return this
    })
    on = vi.fn((event: string, fn: (ctx: any) => Promise<void>) => {
      this.events.set(event, fn)
      return this
    })
    catch = vi.fn()
    init = vi.fn(async () => undefined)
    start = vi.fn(async () => undefined)
    stop = vi.fn(async () => undefined)
  },
  InlineKeyboard: class FakeInlineKeyboard {
    actions: Array<{ label: string; value: string } | 'row'> = []
    text(label: string, value: string) {
      this.actions.push({ label, value })
      return this
    }
    row() {
      this.actions.push('row')
      return this
    }
  },
  InputFile: class FakeInputFile {
    constructor(public buffer: Buffer, public name: string) {}
  },
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: mocks.readFile,
  }
})

vi.mock('../../core/config.js', () => ({
  readAIConfig: mocks.readAIConfig,
  writeAIConfig: mocks.writeAIConfig,
}))

vi.mock('@grammyjs/auto-retry', () => ({
  autoRetry: mocks.autoRetry,
}))

vi.mock('grammy', () => ({
  Bot: mocks.Bot,
  InlineKeyboard: mocks.InlineKeyboard,
  InputFile: mocks.InputFile,
}))

const { TelegramPlugin } = await import('./telegram-plugin.js')

describe('TelegramPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.botInstances.length = 0
    mocks.readAIConfig.mockResolvedValue({ backend: 'claude-code' })
  })

  it('builds prompts from sender identity, text, and media metadata', () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })

    const prompt = (plugin as any).buildPrompt({
      chatId: 123,
      text: 'Check the 5m chart',
      from: { id: 1, firstName: 'Alice', username: 'alice' },
      media: [
        { type: 'photo', fileName: 'chart.png', mimeType: 'image/png' },
        { type: 'document', fileName: 'notes.txt', mimeType: 'text/plain' },
      ],
    })

    expect(prompt).toContain('[From: Alice (@alice)]')
    expect(prompt).toContain('Check the 5m chart')
    expect(prompt).toContain('[photo: chart.png: image/png]')
    expect(prompt).toContain('[document: notes.txt: text/plain]')
  })

  it('sends media, edits the placeholder, and chunks remaining text replies', async () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })
    mocks.readFile.mockResolvedValue(Buffer.from('image-bytes'))

    const api = {
      sendPhoto: vi.fn(async () => undefined),
      editMessageText: vi.fn(async () => true),
      sendMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    }

    ;(plugin as any).bot = { api }

    await (plugin as any).sendReplyWithPlaceholder(
      123,
      `${'a'.repeat(4096)} ${'b'.repeat(100)}`,
      [{ type: 'image', path: '/tmp/chart.png' }],
      99,
    )

    expect(mocks.readFile).toHaveBeenCalledWith('/tmp/chart.png')
    expect(api.sendPhoto).toHaveBeenCalledOnce()
    expect(api.editMessageText).toHaveBeenCalledOnce()
    expect(api.sendMessage).toHaveBeenCalledOnce()
    expect(api.deleteMessage).not.toHaveBeenCalled()
  })

  it('renders settings and heartbeat menus with the current state', async () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })
    mocks.readAIConfig.mockResolvedValue({ backend: 'codex-cli' })

    const sendMessage = vi.fn(async () => undefined)
    ;(plugin as any).bot = { api: { sendMessage } }

    await (plugin as any).sendSettingsMenu(123)
    await (plugin as any).sendHeartbeatMenu(123, {
      heartbeat: { isEnabled: vi.fn(() => false) },
    })

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      123,
      'Current provider: Codex CLI\n\nChoose default AI provider:',
      expect.objectContaining({ reply_markup: expect.anything() }),
    )
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      123,
      'Heartbeat: OFF\n\nToggle heartbeat self-check:',
      expect.objectContaining({ reply_markup: expect.anything() }),
    )
  })

  it('falls back to plain text when markdown rendering fails', async () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('bad html'))
      .mockResolvedValueOnce(undefined)
    ;(plugin as any).bot = { api: { sendMessage } }

    await (plugin as any).sendReply(123, '**hello**')

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      123,
      '<b>hello</b>',
      { parse_mode: 'HTML' },
    )
    expect(sendMessage).toHaveBeenNthCalledWith(2, 123, '**hello**')
  })

  it('runs the compact command through the unified engine session flow', async () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })
    const session = { restore: vi.fn(), id: 'telegram/5' }
    const sendReply = vi.spyOn(plugin as any, 'sendReply').mockResolvedValue(undefined)
    const getSession = vi.spyOn(plugin as any, 'getSession').mockResolvedValue(session)

    await (plugin as any).handleCompactCommand(123, 5, {
      engine: {
        askWithSession: vi.fn(async () => ({ text: 'Compacted.', media: [] })),
      },
      heartbeat: {},
      connectorCenter: {},
      eventLog: {},
      cronEngine: {},
      trader: {},
      traderReview: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
    } as never)

    expect(getSession).toHaveBeenCalledWith(5)
    expect(sendReply).toHaveBeenNthCalledWith(1, 123, '> Compacting session...')
    expect(sendReply).toHaveBeenNthCalledWith(2, 123, 'Compacted.')
  })

  it('handles messages through engine sessions and records sent events', async () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })
    const session = { id: 'telegram/9' }
    const sendMessage = vi.fn(async () => ({ message_id: 77 }))
    const stopTyping = vi.fn()
    vi.spyOn(plugin as any, 'getSession').mockResolvedValue(session)
    vi.spyOn(plugin as any, 'startTypingIndicator').mockReturnValue(stopTyping)
    vi.spyOn(plugin as any, 'sendReplyWithPlaceholder').mockResolvedValue(undefined)
    ;(plugin as any).bot = { api: { sendMessage } }

    const eventLog = {
      append: vi.fn()
        .mockResolvedValueOnce({ ts: 10 })
        .mockResolvedValueOnce(undefined),
    }
    const askWithSession = vi.fn(async () => ({ text: 'Here is the plan', media: [] }))

    await (plugin as any).handleMessage(
      {
        engine: { askWithSession },
        eventLog,
      },
      {
        chatId: 123,
        text: 'Review BTC',
        from: { id: 9, firstName: 'Alice', username: 'alice' },
        media: [],
      },
    )

    expect(askWithSession).toHaveBeenCalledWith(
      '[From: Alice (@alice)]\nReview BTC',
      session,
      expect.objectContaining({
        historyPreamble: expect.stringContaining('Telegram chat'),
        commandContext: expect.objectContaining({
          actorId: '9',
          source: 'telegram',
          surface: 'telegram-chat',
        }),
      }),
    )
    expect((plugin as any).sendReplyWithPlaceholder).toHaveBeenCalledWith(123, 'Here is the plan', [], 77)
    expect(stopTyping).toHaveBeenCalled()
    expect(eventLog.append).toHaveBeenNthCalledWith(
      2,
      'message.sent',
      expect.objectContaining({
        channel: 'telegram',
        to: '123',
        prompt: '[From: Alice (@alice)]\nReview BTC',
        reply: 'Here is the plan',
      }),
    )
  })

  it('replaces the placeholder with an error message when message handling fails', async () => {
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })
    const stopTyping = vi.fn()
    vi.spyOn(plugin as any, 'getSession').mockResolvedValue({ id: 'telegram/5' })
    vi.spyOn(plugin as any, 'startTypingIndicator').mockReturnValue(stopTyping)

    const editMessageText = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ message_id: 55 }))
    ;(plugin as any).bot = { api: { sendMessage, editMessageText } }

    await (plugin as any).handleMessage(
      {
        engine: {
          askWithSession: vi.fn(async () => {
            throw new Error('provider offline')
          }),
        },
        eventLog: {
          append: vi.fn(async () => ({ ts: 20 })),
        },
      },
      {
        chatId: 123,
        text: 'Ping',
        from: { id: 5, firstName: 'Bob', username: undefined },
        media: [],
      },
    )

    expect(stopTyping).toHaveBeenCalled()
    expect(editMessageText).toHaveBeenCalledWith(
      123,
      55,
      'Sorry, something went wrong processing your message.',
    )
  })

  it('starts the bot, registers commands, and blocks unauthorized chats', async () => {
    const register = vi.fn(() => vi.fn())
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })

    await plugin.start({
      connectorCenter: { register },
      heartbeat: { isEnabled: vi.fn(() => true), setEnabled: vi.fn(async () => undefined) },
      engine: { askWithSession: vi.fn() },
      eventLog: { append: vi.fn() },
      cronEngine: {},
      trader: {},
      traderReview: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
    } as never)

    const bot = mocks.botInstances[0]
    expect(bot.api.config.use).toHaveBeenCalledWith('auto-retry-middleware')
    expect(bot.api.setMyCommands).toHaveBeenCalledWith([
      { command: 'status', description: 'Show engine status' },
      { command: 'settings', description: 'Choose default AI provider' },
      { command: 'heartbeat', description: 'Toggle heartbeat self-check' },
      { command: 'compact', description: 'Force compact session context' },
    ])
    expect(register).toHaveBeenCalledTimes(1)
    expect(bot.start).toHaveBeenCalledWith({
      allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
      onStart: expect.any(Function),
    })

    const next = vi.fn(async () => undefined)
    const reply = vi.fn(async () => undefined)
    await bot.middlewares[0]({ chat: { id: 999 }, reply }, next)
    expect(reply).toHaveBeenCalledWith(
      'This chat is not authorized. Add this chat ID to TELEGRAM_CHAT_ID in your environment config.',
    )
    expect(next).not.toHaveBeenCalled()

    await bot.middlewares[0]({ chat: { id: 123 }, reply }, next)
    expect(next).toHaveBeenCalled()
  })

  it('handles provider and heartbeat callback queries after start', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const plugin = new TelegramPlugin({ token: 'secret', allowedChatIds: [123] })

    await plugin.start({
      connectorCenter: { register: vi.fn(() => vi.fn()) },
      heartbeat: { isEnabled: vi.fn(() => true), setEnabled },
      engine: { askWithSession: vi.fn() },
      eventLog: { append: vi.fn() },
      cronEngine: {},
      trader: {},
      traderReview: {},
      accountManager: {},
      backtest: {},
      marketData: {},
      getAccountGit: vi.fn(),
      reconnectAccount: vi.fn(),
      removeTradingAccountRuntime: vi.fn(),
      runTraderReview: vi.fn(),
      toolCenter: {},
      config: {},
    } as never)

    const bot = mocks.botInstances[0]
    const callback = bot.events.get('callback_query:data')
    const answerCallbackQuery = vi.fn(async () => undefined)
    const editMessageText = vi.fn(async () => undefined)

    await callback({
      callbackQuery: { data: 'provider:codex-cli' },
      answerCallbackQuery,
      editMessageText,
    })
    await callback({
      callbackQuery: { data: 'heartbeat:off' },
      answerCallbackQuery,
      editMessageText,
    })

    expect(mocks.writeAIConfig).toHaveBeenCalledWith('codex-cli')
    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Switched to Codex CLI' })
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Heartbeat OFF' })
  })
})
