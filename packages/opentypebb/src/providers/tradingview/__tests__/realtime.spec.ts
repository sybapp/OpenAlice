import { describe, expect, it } from 'vitest'

import {
  TradingViewBuiltInIndicator,
  TradingViewChartSession,
  TradingViewChartStudy,
  TradingViewPineIndicator,
  TradingViewQuoteSession,
  TradingViewRealtimeClient,
  formatHeartbeat,
  formatRealtimeCommand,
  formatRealtimeFrame,
  parseRealtimeFrames,
} from '../index.js'
import type { TradingViewRealtimeSocket } from '../index.js'

class FakeSocket implements TradingViewRealtimeSocket {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (() => void) | ((event: unknown) => void) | ((event: { data: unknown }) => void),
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<(event?: unknown) => void>()
    listeners.add(listener as (event?: unknown) => void)
    this.listeners.set(type, listeners)
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  message(data: string): void {
    this.emit('message', { data })
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function createClient() {
  const socket = new FakeSocket()
  const client = new TradingViewRealtimeClient({
    socketFactory: () => socket,
  })
  socket.open()
  return { client, socket }
}

describe('TradingView realtime protocol', () => {
  it('formats and parses websocket frames and heartbeats', () => {
    const command = formatRealtimeCommand('quote_create_session', ['qs_abc'])
    const heartbeat = formatHeartbeat(42)

    expect(command).toBe('~m~43~m~{"m":"quote_create_session","p":["qs_abc"]}')
    expect(parseRealtimeFrames(`${command}${heartbeat}`)).toEqual([
      { m: 'quote_create_session', p: ['qs_abc'] },
      42,
    ])
  })

  it('ignores malformed fragments instead of throwing', () => {
    expect(parseRealtimeFrames(`${formatRealtimeFrame('{bad json')}${formatRealtimeCommand('ok')}`))
      .toEqual([{ m: 'ok', p: [] }])
  })
})

describe('TradingView chart session', () => {
  it('resolves a market, creates a series, normalizes candle updates, and fetches more data', () => {
    const { client, socket } = createClient()
    const session = new TradingViewChartSession(client)
    const updates: unknown[] = []

    const subscription = session.subscribe('NASDAQ:AAPL', (data) => updates.push(data), {
      timeframe: '60',
      range: 2,
      session: 'extended',
    })

    expect(socket.sent).toContain(formatRealtimeCommand('chart_create_session', [session.sessionId]))
    expect(socket.sent.some((packet) => packet.includes('resolve_symbol') && packet.includes('NASDAQ:AAPL'))).toBe(true)
    expect(socket.sent).toContain(formatRealtimeCommand('create_series', [
      session.sessionId,
      '$prices',
      's1',
      'ser_1',
      '60',
      2,
    ]))

    socket.message(formatRealtimeCommand('timescale_update', [
      session.sessionId,
      {
        $prices: {
          s: [
            { i: 1, v: [1717200000, 190, 195, 189, 194, 123.456] },
            { i: 2, v: [1717203600, 194, 196, 193, 195, 10] },
          ],
        },
      },
    ]))

    expect(updates).toEqual([{
      symbol: 'NASDAQ:AAPL',
      candles: [
        { time: 1717200000, open: 190, high: 195, low: 189, close: 194, volume: 123.46 },
        { time: 1717203600, open: 194, high: 196, low: 193, close: 195, volume: 10 },
      ],
      changes: ['$prices'],
      marketInfo: null,
    }])

    session.fetchMore(5)
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('request_more_data', [session.sessionId, '$prices', 5]))

    subscription.close()
    session.close()
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('chart_delete_session', [session.sessionId]))
  })

  it('tracks resolved symbol metadata, emits chart errors, and switches timezone', () => {
    const { client, socket } = createClient()
    const session = new TradingViewChartSession(client)
    const infos: unknown[] = []
    const errors: unknown[] = []
    const updates: unknown[] = []

    session.onSymbolResolved((info) => infos.push(info))
    session.onError((error) => errors.push(error))
    session.subscribe('NASDAQ:AAPL', (data) => updates.push(data))

    socket.message(formatRealtimeCommand('symbol_resolved', [
      session.sessionId,
      'ser_1',
      { full_name: 'NASDAQ:AAPL', currency_code: 'USD', timezone: 'America/New_York' },
    ]))
    socket.message(formatRealtimeCommand('timescale_update', [
      session.sessionId,
      { $prices: { s: [{ i: 1, v: [1717200000, 190, 195, 189, 194, 1] }] } },
    ]))
    socket.message(formatRealtimeCommand('symbol_error', [session.sessionId, 'ser_1', 'invalid symbol']))
    socket.message(formatRealtimeCommand('series_error', [session.sessionId, '$prices', 's1', 'custom_resolution']))
    socket.message(formatRealtimeCommand('critical_error', [session.sessionId, 'invalid timezone', 'method: switch_timezone']))

    expect(infos).toEqual([{
      seriesId: 'ser_1',
      full_name: 'NASDAQ:AAPL',
      currency_code: 'USD',
      timezone: 'America/New_York',
    }])
    expect(updates).toEqual([expect.objectContaining({
      marketInfo: {
        seriesId: 'ser_1',
        full_name: 'NASDAQ:AAPL',
        currency_code: 'USD',
        timezone: 'America/New_York',
      },
    })])
    expect(errors).toEqual([
      { kind: 'symbol_error', message: 'invalid symbol', details: [session.sessionId, 'ser_1', 'invalid symbol'] },
      { kind: 'series_error', message: 'custom_resolution', details: [session.sessionId, '$prices', 's1', 'custom_resolution'] },
      { kind: 'critical_error', message: 'invalid timezone', details: 'method: switch_timezone' },
    ])

    session.setTimezone('Asia/Shanghai')
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('switch_timezone', [session.sessionId, 'Asia/Shanghai']))
    expect(session.currentCandles).toEqual([])
  })

  it('sends custom chart type payloads and replay controls', async () => {
    const { client, socket } = createClient()
    const session = new TradingViewChartSession(client)
    const replayEvents: unknown[] = []
    session.onReplay((event) => replayEvents.push(event))

    session.subscribe('BINANCE:BTCUSDT', () => {}, {
      timeframe: '15',
      range: 10,
      type: 'Renko',
      inputs: { source: 'close', style: 'ATR', atrLength: 14 },
      replay: 1717200000,
    })

    expect(socket.sent).toContain(formatRealtimeCommand('replay_create_session', [session.replaySessionId]))
    expect(socket.sent).toContain(formatRealtimeCommand('replay_reset', [
      session.replaySessionId,
      'req_replay_reset',
      1717200000,
    ]))
    expect(socket.sent.some((packet) => (
      packet.includes('resolve_symbol') &&
      packet.includes('BarSetRenko@tv-prostudies-40!') &&
      packet.includes(session.replaySessionId)
    ))).toBe(true)

    const stepPromise = session.replayStep(2)
    const stepFrame = [...socket.sent].reverse()
      .map((packet) => parseRealtimeFrames(packet)[0])
      .find((frame) => typeof frame === 'object' && frame.m === 'replay_step')
    const stepRequest = typeof stepFrame === 'object' && Array.isArray(stepFrame.p)
      ? String(stepFrame.p[1])
      : ''
    socket.message(formatRealtimeCommand('replay_ok', [session.replaySessionId, stepRequest]))
    await expect(stepPromise).resolves.toBeUndefined()

    socket.message(formatRealtimeCommand('replay_instance_id', [session.replaySessionId, 'instance-1']))
    socket.message(formatRealtimeCommand('replay_point', [session.replaySessionId, 15]))
    socket.message(formatRealtimeCommand('replay_resolutions', [session.replaySessionId, '15', 10]))
    socket.message(formatRealtimeCommand('replay_data_end', [session.replaySessionId]))
    expect(replayEvents).toEqual([
      { type: 'loaded', value: 'instance-1' },
      { type: 'point', value: 15 },
      { type: 'resolution', value: '15', extra: 10 },
      { type: 'end' },
    ])

    const stopPromise = session.replayStop()
    const stopFrame = [...socket.sent].reverse()
      .map((packet) => parseRealtimeFrames(packet)[0])
      .find((frame) => typeof frame === 'object' && frame.m === 'replay_stop')
    const stopRequest = typeof stopFrame === 'object' && Array.isArray(stopFrame.p)
      ? String(stopFrame.p[1])
      : ''
    socket.message(formatRealtimeCommand('replay_ok', [session.replaySessionId, stopRequest]))
    await expect(stopPromise).resolves.toBeUndefined()

    session.close()
    expect(socket.sent).toContain(formatRealtimeCommand('replay_delete_session', [session.replaySessionId]))
  })
})

describe('TradingView chart study', () => {
  it('creates, updates, modifies, and removes Pine studies', () => {
    const { client, socket } = createClient()
    const chart = new TradingViewChartSession(client)
    chart.subscribe('NASDAQ:AAPL', () => {})
    const indicator = new TradingViewPineIndicator({
      pineId: 'PUB;abc',
      pineVersion: '5',
      description: 'Super Trend',
      shortDescription: 'ST',
      inputs: {
        in_Factor: {
          name: 'Factor',
          inline: 'Factor',
          internalID: 'Factor',
          type: 'float',
          value: 3,
          isHidden: false,
          isFake: false,
        },
      },
      plots: { plot_0: 'Trend', plot_1: 'Direction' },
      script: 'pine bytecode',
    })
    const study = new TradingViewChartStudy(chart, indicator)
    const ready: string[] = []
    const updates: unknown[] = []
    const errors: unknown[] = []
    study.onReady(() => ready.push('ready'))
    study.onUpdate((update) => updates.push(update))
    study.onError((error) => errors.push(error))

    expect(socket.sent.some((packet) => (
      packet.includes('create_study') &&
      packet.includes(study.studyId) &&
      packet.includes('Script@tv-scripting-101!') &&
      packet.includes('pine bytecode')
    ))).toBe(true)

    socket.message(formatRealtimeCommand('study_completed', [chart.sessionId, study.studyId]))
    expect(ready).toEqual(['ready'])

    socket.message(formatRealtimeCommand('timescale_update', [
      chart.sessionId,
      {
        [study.studyId]: {
          st: [
            { v: [1717200000, 1.5, -1] },
            { v: [1717203600, 1.7, 1] },
          ],
          ns: {
            d: JSON.stringify({
              graphicsCmds: { create: { dwglines: [{ data: [{ id: 1, x: 10 }] }] } },
              data: {
                report: {
                  currency: 'USD',
                  performance: { all: { totalTrades: 1 } },
                  trades: [
                    {
                      e: { c: 'Buy', tp: ['l'], p: 100, tm: 1 },
                      x: { c: 'Sell', p: 110, tm: 2 },
                      q: 1,
                      tp: 10,
                      cp: 10,
                      rn: 12,
                      dd: -1,
                    },
                  ],
                  equity: [100, 110],
                  drawDown: [0, -1],
                },
              },
            }),
          },
        },
      },
    ]))

    expect(updates).toEqual([{
      changes: ['plots', 'graphic', 'report.currency', 'report.perf', 'report.trades', 'report.history'],
      points: [
        { $time: 1717200000, Trend: 1.5, Direction: -1 },
        { $time: 1717203600, Trend: 1.7, Direction: 1 },
      ],
      strategyReport: {
        currency: 'USD',
        performance: { all: { totalTrades: 1 } },
        trades: [{
          entry: { name: 'Buy', type: 'long', value: 100, time: 1 },
          exit: { name: 'Sell', value: 110, time: 2 },
          quantity: 1,
          profit: 10,
          cumulative: 10,
          runup: 12,
          drawdown: -1,
        }],
        history: {
          buyHold: undefined,
          buyHoldPercent: undefined,
          drawDown: [0, -1],
          drawDownPercent: undefined,
          equity: [100, 110],
          equityPercent: undefined,
        },
      },
      graphics: { create: { dwglines: [{ data: [{ id: 1, x: 10 }] }] } },
    }])

    socket.message(formatRealtimeCommand('study_error', [chart.sessionId, study.studyId, 'st1', 'invalid value', 'Factor']))
    expect(errors).toEqual([{ message: 'invalid value', details: 'Factor' }])

    const builtIn = new TradingViewBuiltInIndicator('Volume@tv-basicstudies-241')
    builtIn.setOption('length', 10)
    study.setIndicator(builtIn)
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('modify_study', [
      chart.sessionId,
      study.studyId,
      'st1',
      { length: 10, col_prev_close: false },
    ]))

    study.remove()
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('remove_study', [chart.sessionId, study.studyId]))
  })
})

describe('TradingView realtime client', () => {
  it('queues commands until the socket opens and answers heartbeats', () => {
    const socket = new FakeSocket()
    const client = new TradingViewRealtimeClient({ socketFactory: () => socket })
    const heartbeats: number[] = []
    client.on('heartbeat', (value) => heartbeats.push(Number(value)))

    client.send('quote_create_session', ['qs_abc'])
    expect(socket.sent).toEqual([])

    socket.open()
    expect(socket.sent).toEqual([
      formatRealtimeCommand('set_auth_token', ['unauthorized_user_token']),
      formatRealtimeCommand('quote_create_session', ['qs_abc']),
    ])

    socket.message(formatHeartbeat(7))
    expect(socket.sent.at(-1)).toBe(formatHeartbeat(7))
    expect(heartbeats).toEqual([7])
  })

  it('dispatches packets by session id before emitting generic packets', () => {
    const { client, socket } = createClient()
    const sessionPackets: unknown[] = []
    const genericPackets: unknown[] = []

    client.registerSession('qs_abc', {
      type: 'quote',
      onPacket: (packet) => sessionPackets.push(packet),
    })
    client.on('packet', (packet) => genericPackets.push(packet))

    socket.message(formatRealtimeCommand('qsd', ['qs_abc', { s: 'ok' }]))
    socket.message(formatRealtimeCommand('session_id', ['server-session']))

    expect(sessionPackets).toEqual([{ type: 'qsd', data: ['qs_abc', { s: 'ok' }] }])
    expect(genericPackets).toEqual([{ m: 'session_id', p: ['server-session'] }])
  })
})

describe('TradingView quote session', () => {
  it('subscribes once per symbol, merges updates, and removes the symbol after the last listener closes', () => {
    const { client, socket } = createClient()
    const session = new TradingViewQuoteSession(client, { fields: 'summary' })
    const updates: unknown[] = []

    const subscriptionA = session.subscribe('NASDAQ:AAPL', (data) => updates.push(data))
    const subscriptionB = session.subscribe('NASDAQ:AAPL', (data) => updates.push({ second: data }))
    const key = '= {"session":"regular","symbol":"NASDAQ:AAPL"}'.replace(' ', '')

    const addSymbolCommands = socket.sent.filter((packet) => packet.includes('quote_add_symbols'))
    expect(addSymbolCommands).toHaveLength(1)

    socket.message(formatRealtimeCommand('qsd', [
      session.sessionId,
      { n: key, s: 'ok', v: { lp: 190, volume: 10 } },
    ]))
    socket.message(formatRealtimeCommand('qsd', [
      session.sessionId,
      { n: key, s: 'ok', v: { lp: 191 } },
    ]))

    expect(updates).toEqual([
      { symbol: key, values: { lp: 190, volume: 10 } },
      { second: { symbol: key, values: { lp: 190, volume: 10 } } },
      { symbol: key, values: { lp: 191, volume: 10 } },
      { second: { symbol: key, values: { lp: 191, volume: 10 } } },
    ])

    subscriptionA.close()
    expect(socket.sent.some((packet) => packet.includes('quote_remove_symbols'))).toBe(false)
    subscriptionB.close()
    expect(socket.sent.at(-1)).toBe(formatRealtimeCommand('quote_remove_symbols', [session.sessionId, key]))
  })
})
