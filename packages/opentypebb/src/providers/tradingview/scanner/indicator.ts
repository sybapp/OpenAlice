import type { TradingViewCredentials, TradingViewRequestOptions } from './types.js'

export type TradingViewPineInputType =
  | 'text'
  | 'source'
  | 'integer'
  | 'float'
  | 'resolution'
  | 'bool'
  | 'color'
  | string

export interface TradingViewPineInput {
  name: string
  inline: string
  internalID: string
  tooltip?: string
  type: TradingViewPineInputType
  value: string | number | boolean
  isHidden: boolean
  isFake: boolean
  options?: Array<string | number | boolean>
}

export type TradingViewPineIndicatorType =
  | 'Script@tv-scripting-101!'
  | 'StrategyScript@tv-scripting-101!'
  | string

export interface TradingViewPineIndicatorOptions {
  pineId: string
  pineVersion: string
  description: string
  shortDescription: string
  inputs: Record<string, TradingViewPineInput>
  plots: Record<string, string>
  script: string
}

export type TradingViewIndicatorAccess =
  | 'open_source'
  | 'closed_source'
  | 'invite_only'
  | 'private'
  | 'other'

export interface TradingViewIndicatorSearchResult {
  id: string
  version: string
  name: string
  author: { id: number; username: string }
  image: string
  source: string
  type: 'study' | 'strategy' | string
  access: TradingViewIndicatorAccess
}

export interface TradingViewIndicatorSearchOptions extends TradingViewRequestOptions {
  includeBuiltIn?: boolean
}

export class TradingViewPineIndicator {
  private indicatorType: TradingViewPineIndicatorType = 'Script@tv-scripting-101!'

  constructor(private readonly options: TradingViewPineIndicatorOptions) {}

  get pineId(): string { return this.options.pineId }
  get pineVersion(): string { return this.options.pineVersion }
  get description(): string { return this.options.description }
  get shortDescription(): string { return this.options.shortDescription }
  get inputs(): Record<string, TradingViewPineInput> { return this.options.inputs }
  get plots(): Record<string, string> { return this.options.plots }
  get script(): string { return this.options.script }
  get type(): TradingViewPineIndicatorType { return this.indicatorType }

  setType(type: TradingViewPineIndicatorType): void {
    this.indicatorType = type
  }

  setOption(key: string, value: string | number | boolean): void {
    const inputKey =
      this.options.inputs[`in_${key}`]
        ? `in_${key}`
        : this.options.inputs[key]
          ? key
          : Object.keys(this.options.inputs).find((id) => (
              this.options.inputs[id]?.inline === key ||
              this.options.inputs[id]?.internalID === key
            ))

    if (!inputKey || !this.options.inputs[inputKey]) {
      throw new Error(`Input '${key}' not found.`)
    }

    const input = this.options.inputs[inputKey]
    const expectedType = {
      bool: 'boolean',
      integer: 'number',
      float: 'number',
      text: 'string',
    }[input.type]
    if (expectedType && typeof value !== expectedType) {
      throw new Error(`Input '${input.name}' (${inputKey}) must be a ${expectedType}.`)
    }
    if (input.options && !input.options.includes(value)) {
      throw new Error(`Input '${input.name}' (${inputKey}) must be one of the allowed values.`)
    }

    input.value = value
  }
}

export type TradingViewBuiltInIndicatorType =
  | 'Volume@tv-basicstudies-241'
  | 'VbPFixed@tv-basicstudies-241'
  | 'VbPFixed@tv-basicstudies-241!'
  | 'VbPFixed@tv-volumebyprice-53!'
  | 'VbPSessions@tv-volumebyprice-53'
  | 'VbPSessionsRough@tv-volumebyprice-53!'
  | 'VbPSessionsDetailed@tv-volumebyprice-53!'
  | 'VbPVisible@tv-volumebyprice-53'
  | string

const builtInDefaults: Record<string, Record<string, unknown>> = {
  'Volume@tv-basicstudies-241': {
    length: 20,
    col_prev_close: false,
  },
  'VbPFixed@tv-basicstudies-241': {
    rowsLayout: 'Number Of Rows',
    rows: 24,
    volume: 'Up/Down',
    vaVolume: 70,
    subscribeRealtime: false,
    first_bar_time: NaN,
    last_bar_time: Date.now(),
    extendToRight: false,
    mapRightBoundaryToBarStartTime: true,
  },
  'VbPFixed@tv-basicstudies-241!': {
    rowsLayout: 'Number Of Rows',
    rows: 24,
    volume: 'Up/Down',
    vaVolume: 70,
    subscribeRealtime: false,
    first_bar_time: NaN,
    last_bar_time: Date.now(),
  },
  'VbPFixed@tv-volumebyprice-53!': {
    rowsLayout: 'Number Of Rows',
    rows: 24,
    volume: 'Up/Down',
    vaVolume: 70,
    subscribeRealtime: false,
    first_bar_time: NaN,
    last_bar_time: Date.now(),
  },
  'VbPSessions@tv-volumebyprice-53': {
    rowsLayout: 'Number Of Rows',
    rows: 24,
    volume: 'Up/Down',
    vaVolume: 70,
    extendPocRight: false,
  },
  'VbPSessionsRough@tv-volumebyprice-53!': {
    volume: 'Up/Down',
    vaVolume: 70,
  },
  'VbPSessionsDetailed@tv-volumebyprice-53!': {
    volume: 'Up/Down',
    vaVolume: 70,
    subscribeRealtime: false,
    first_visible_bar_time: NaN,
    last_visible_bar_time: Date.now(),
  },
  'VbPVisible@tv-volumebyprice-53': {
    rowsLayout: 'Number Of Rows',
    rows: 24,
    volume: 'Up/Down',
    vaVolume: 70,
    subscribeRealtime: false,
    first_visible_bar_time: NaN,
    last_visible_bar_time: Date.now(),
  },
}

export class TradingViewBuiltInIndicator {
  readonly options: Record<string, unknown>

  constructor(readonly type: TradingViewBuiltInIndicatorType) {
    if (!type) {
      throw new Error(`Wrong built-in indicator type "${type}".`)
    }
    this.options = { ...(builtInDefaults[type] ?? {}) }
  }

  setOption(key: string, value: unknown, force = false): void {
    const defaults = builtInDefaults[this.type]
    if (!force && defaults) {
      if (!(key in defaults)) {
        throw new Error(`Option '${key}' is denied with '${this.type}' indicator.`)
      }
      const expectedType = typeof defaults[key]
      if (typeof value !== expectedType) {
        throw new Error(`Wrong '${key}' value type '${typeof value}' (must be '${expectedType}').`)
      }
    }
    this.options[key] = value
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function authCookie(credentials: TradingViewCredentials | null | undefined): string {
  const session = credentials?.tradingview_sessionid
  if (!session) return ''
  return credentials?.tradingview_sessionid_sign
    ? `sessionid=${session}; sessionid_sign=${credentials.tradingview_sessionid_sign}`
    : `sessionid=${session}`
}

async function requestJson<T>(url: string, init: RequestInit, options: TradingViewRequestOptions): Promise<T> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('No fetch implementation available for TradingView indicator request')

  const controller = options.signal ? null : new AbortController()
  const timeoutMs = options.timeoutMs ?? 20_000
  const timeout = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: options.signal ?? controller?.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`TradingView indicator request failed: ${response.status} ${response.statusText}\n Body: ${body}\n`)
    }
    return await response.json() as T
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

type PineListItem = {
  scriptIdPart?: string
  version?: string
  scriptName?: string
  userId?: number
  author?: { id?: number; username?: string }
  imageUrl?: string
  access?: number
  scriptSource?: string
  extra?: { kind?: string; shortDescription?: string }
}

function normalizeIndicator(item: PineListItem, builtIn = false): TradingViewIndicatorSearchResult {
  return {
    id: String(item.scriptIdPart ?? ''),
    version: String(item.version ?? 'last'),
    name: String(item.scriptName ?? ''),
    author: builtIn
      ? { id: Number(item.userId ?? -1), username: '@TRADINGVIEW@' }
      : { id: Number(item.author?.id ?? -1), username: String(item.author?.username ?? '') },
    image: String(item.imageUrl ?? ''),
    access: builtIn
      ? 'closed_source'
      : (['open_source', 'closed_source', 'invite_only'][Number(item.access ?? 0) - 1] ?? 'other') as TradingViewIndicatorAccess,
    source: String(item.scriptSource ?? ''),
    type: String(item.extra?.kind ?? 'study'),
  }
}

function norm(value = ''): string {
  return value.toUpperCase().replace(/[^A-Z]/g, '')
}

export async function searchIndicators(
  search = '',
  options: TradingViewIndicatorSearchOptions = {},
): Promise<TradingViewIndicatorSearchResult[]> {
  const headers = headersToRecord(options.headers)
  const results: TradingViewIndicatorSearchResult[] = []
  const seen = new Set<string>()
  const pushUnique = (indicator: TradingViewIndicatorSearchResult) => {
    const key = `${indicator.id}@${indicator.version}`
    if (seen.has(key)) return
    seen.add(key)
    results.push(indicator)
  }

  if (options.includeBuiltIn ?? true) {
    const lists = await Promise.all(['standard', 'candlestick', 'fundamental'].map(async (filter) =>
      requestJson<PineListItem[]>(
        `https://pine-facade.tradingview.com/pine-facade/list?filter=${filter}`,
        { method: 'GET', headers },
        options,
      ),
    ))
    const target = norm(search)
    for (const item of lists.flat()) {
      if (!target || norm(item.scriptName).includes(target) || norm(item.extra?.shortDescription).includes(target)) {
        pushUnique(normalizeIndicator(item, true))
      }
    }
  }

  const suggested = await requestJson<{ results?: PineListItem[] }>(
    `https://www.tradingview.com/pubscripts-suggest-json?search=${encodeURIComponent(search).replace(/%20/g, '%20')}`,
    { method: 'GET', headers },
    options,
  )
  for (const item of suggested.results ?? []) {
    pushUnique(normalizeIndicator(item))
  }
  return results
}

type PineTranslateResponse = {
  success?: boolean
  reason?: string
  result?: {
    ilTemplate?: string
    metaInfo?: {
      scriptIdPart?: string
      description?: string
      shortDescription?: string
      inputs?: Array<{
        id: string
        name: string
        inline?: string
        internalID?: string
        tooltip?: string
        type: TradingViewPineInputType
        defval: string | number | boolean
        isHidden?: boolean
        isFake?: boolean
        options?: Array<string | number | boolean>
      }>
      styles?: Record<string, { title?: string }>
      plots?: Array<{ id: string; target?: string; type?: string }>
      pine?: { version?: string }
    }
  }
}

function safePlotName(value: string): string {
  return value.replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '')
}

export async function getIndicator(
  id: string,
  version = 'last',
  options: TradingViewRequestOptions = {},
): Promise<TradingViewPineIndicator> {
  const indicatorId = id.replace(/ |%/g, '%25')
  const headers = headersToRecord(options.headers)
  const cookie = authCookie(options.credentials)
  if (cookie) headers.cookie = cookie

  const data = await requestJson<PineTranslateResponse>(
    `https://pine-facade.tradingview.com/pine-facade/translate/${indicatorId}/${version}`,
    { method: 'GET', headers },
    options,
  )

  const meta = data.result?.metaInfo
  if (!data.success || !meta?.inputs) {
    throw new Error(`Inexistent or unsupported indicator: "${data.reason ?? 'unknown'}"`)
  }

  const inputs: Record<string, TradingViewPineInput> = {}
  for (const input of meta.inputs) {
    if (['text', 'pineId', 'pineVersion'].includes(input.id)) continue
    const inlineName = safePlotName(input.name)
    inputs[input.id] = {
      name: input.name,
      inline: input.inline || inlineName,
      internalID: input.internalID || inlineName,
      tooltip: input.tooltip,
      type: input.type,
      value: input.defval,
      isHidden: !!input.isHidden,
      isFake: !!input.isFake,
      ...(input.options ? { options: input.options } : {}),
    }
  }

  const plots: Record<string, string> = {}
  for (const [plotId, style] of Object.entries(meta.styles ?? {})) {
    const baseTitle = safePlotName(style.title ?? plotId)
    const titles = new Set(Object.values(plots))
    if (!titles.has(baseTitle)) {
      plots[plotId] = baseTitle
      continue
    }
    let next = 2
    while (titles.has(`${baseTitle}_${next}`)) next += 1
    plots[plotId] = `${baseTitle}_${next}`
  }
  for (const plot of meta.plots ?? []) {
    if (plot.target) {
      plots[plot.id] = `${plots[plot.target] ?? plot.target}_${plot.type ?? 'plot'}`
    }
  }

  return new TradingViewPineIndicator({
    pineId: meta.scriptIdPart || indicatorId,
    pineVersion: meta.pine?.version || version,
    description: meta.description ?? '',
    shortDescription: meta.shortDescription ?? '',
    inputs,
    plots,
    script: data.result?.ilTemplate ?? '',
  })
}
