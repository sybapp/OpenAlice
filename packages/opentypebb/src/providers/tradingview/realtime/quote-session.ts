import { createSessionId } from './session-id.js'
import type { TradingViewRealtimeClient } from './client.js'
import type { TradingViewRealtimeListener } from './types.js'

export type TradingViewQuoteField =
  | 'base-currency-logoid'
  | 'ch'
  | 'chp'
  | 'currency-logoid'
  | 'provider_id'
  | 'currency_code'
  | 'current_session'
  | 'description'
  | 'exchange'
  | 'format'
  | 'fractional'
  | 'is_tradable'
  | 'language'
  | 'local_description'
  | 'logoid'
  | 'lp'
  | 'lp_time'
  | 'minmov'
  | 'minmove2'
  | 'original_name'
  | 'pricescale'
  | 'pro_name'
  | 'short_name'
  | 'type'
  | 'update_mode'
  | 'volume'
  | 'ask'
  | 'bid'
  | 'fundamentals'
  | 'high_price'
  | 'low_price'
  | 'open_price'
  | 'prev_close_price'
  | 'rch'
  | 'rchp'
  | 'rtc'
  | 'rtc_time'
  | 'status'
  | 'industry'
  | 'basic_eps_net_income'
  | 'beta_1_year'
  | 'market_cap_basic'
  | 'earnings_per_share_basic_ttm'
  | 'price_earnings_ttm'
  | 'sector'
  | 'dividends_yield'
  | 'timezone'
  | 'country_code'

export type TradingViewQuoteFieldPreset = 'price' | 'summary' | 'full'

export interface TradingViewQuoteData {
  symbol: string
  values: Record<string, unknown>
}

export interface TradingViewQuoteSubscription {
  close(): void
}

export interface TradingViewQuoteSessionOptions {
  fields?: TradingViewQuoteFieldPreset
  customFields?: TradingViewQuoteField[]
}

const quoteFields: Record<TradingViewQuoteFieldPreset, TradingViewQuoteField[]> = {
  price: ['lp'],
  summary: [
    'lp',
    'lp_time',
    'ch',
    'chp',
    'bid',
    'ask',
    'volume',
    'open_price',
    'high_price',
    'low_price',
    'prev_close_price',
    'currency_code',
    'exchange',
    'description',
    'type',
    'timezone',
  ],
  full: [
    'base-currency-logoid',
    'ch',
    'chp',
    'currency-logoid',
    'currency_code',
    'current_session',
    'description',
    'exchange',
    'format',
    'fractional',
    'is_tradable',
    'language',
    'local_description',
    'logoid',
    'lp',
    'lp_time',
    'minmov',
    'minmove2',
    'original_name',
    'pricescale',
    'pro_name',
    'short_name',
    'type',
    'update_mode',
    'volume',
    'ask',
    'bid',
    'fundamentals',
    'high_price',
    'low_price',
    'open_price',
    'prev_close_price',
    'rch',
    'rchp',
    'rtc',
    'rtc_time',
    'status',
    'industry',
    'basic_eps_net_income',
    'beta_1_year',
    'market_cap_basic',
    'earnings_per_share_basic_ttm',
    'price_earnings_ttm',
    'sector',
    'dividends_yield',
    'timezone',
    'country_code',
    'provider_id',
  ],
}

function symbolKey(symbol: string, session: string): string {
  return `=${JSON.stringify({ session, symbol })}`
}

function selectedFields(options: TradingViewQuoteSessionOptions): TradingViewQuoteField[] {
  if (options.customFields?.length) {
    return options.customFields
  }
  return quoteFields[options.fields ?? 'full']
}

export class TradingViewQuoteSession {
  readonly sessionId = createSessionId('qs')

  private readonly listeners = new Map<string, Set<TradingViewRealtimeListener<[TradingViewQuoteData]>>>()
  private readonly lastValues = new Map<string, Record<string, unknown>>()

  constructor(
    private readonly client: TradingViewRealtimeClient,
    options: TradingViewQuoteSessionOptions = {},
  ) {
    this.client.registerSession(this.sessionId, {
      type: 'quote',
      onPacket: (packet) => this.handlePacket(packet),
    })
    this.client.send('quote_create_session', [this.sessionId])
    this.client.send('quote_set_fields', [this.sessionId, ...selectedFields(options)])
  }

  subscribe(
    symbol: string,
    listener: TradingViewRealtimeListener<[TradingViewQuoteData]>,
    session = 'regular',
  ): TradingViewQuoteSubscription {
    const key = symbolKey(symbol, session)
    const listeners = this.listeners.get(key) ?? new Set<TradingViewRealtimeListener<[TradingViewQuoteData]>>()
    const isNewSymbol = listeners.size === 0
    listeners.add(listener)
    this.listeners.set(key, listeners)

    if (isNewSymbol) {
      this.client.send('quote_add_symbols', [this.sessionId, key])
    }

    return {
      close: () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          this.listeners.delete(key)
          this.lastValues.delete(key)
          this.client.send('quote_remove_symbols', [this.sessionId, key])
        }
      },
    }
  }

  close(): void {
    this.client.send('quote_delete_session', [this.sessionId])
    this.client.unregisterSession(this.sessionId)
    this.listeners.clear()
    this.lastValues.clear()
  }

  private handlePacket(packet: { type: string; data: unknown[] }): void {
    if (packet.type !== 'qsd') {
      return
    }

    const payload = packet.data[1]
    if (!payload || typeof payload !== 'object') {
      return
    }

    const source = payload as { n?: unknown; s?: unknown; v?: unknown }
    if (source.s !== 'ok' || typeof source.n !== 'string' || !source.v || typeof source.v !== 'object') {
      return
    }

    const existing = this.lastValues.get(source.n) ?? {}
    const values = { ...existing, ...(source.v as Record<string, unknown>) }
    this.lastValues.set(source.n, values)

    for (const listener of this.listeners.get(source.n) ?? []) {
      listener({ symbol: source.n, values })
    }
  }
}
