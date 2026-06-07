import { OPTIONS_SCAN2_URL, DEFAULT_RANGE, Query, SCAN_URL } from './query.js'

function scannerUrl(market: string): string {
  return SCAN_URL.replace('{market}', market)
}

export function stocks(market = 'america'): Query {
  return new Query(market)
}

export function coin(): Query {
  const q = new Query()
  q.url = scannerUrl('coin')
  q.query = {
    markets: ['coin'],
    symbols: {},
    options: { lang: 'en' },
    columns: [
      'ticker-view',
      'crypto_total_rank',
      'close',
      'type',
      'typespecs',
      'pricescale',
      'minmov',
      'fractional',
      'minmove2',
      'currency',
      '24h_close_change|5',
      'market_cap_calc',
      'fundamental_currency_code',
      '24h_vol_cmc',
      'circulating_supply',
      '24h_vol_to_market_cap',
      'socialdominance',
      'crypto_common_categories.tr',
      'TechRating_1D',
      'TechRating_1D.tr',
    ],
    sort: { sortBy: 'crypto_total_rank', sortOrder: 'asc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function crypto(): Query {
  const q = new Query()
  q.url = scannerUrl('crypto')
  q.query = {
    markets: ['crypto'],
    symbols: {},
    options: { lang: 'en' },
    columns: [
      'ticker-view',
      'exchange.tr',
      'provider-id',
      'close',
      'type',
      'typespecs',
      'pricescale',
      'minmov',
      'fractional',
      'minmove2',
      'currency',
      '24h_close_change|5',
      '24h_vol|5',
      '24h_vol_change|5',
      'TechRating_1D',
      'TechRating_1D.tr',
    ],
    filter2: {
      operator: 'and',
      operands: [
        { expression: { left: 'centralization', operation: 'equal', right: 'cex' } },
      ],
    },
    sort: { sortBy: '24h_vol|5', sortOrder: 'desc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function cryptoDex(): Query {
  const q = new Query()
  q.url = scannerUrl('crypto')
  q.query = {
    markets: ['crypto'],
    symbols: {},
    options: { lang: 'en' },
    columns: [
      'ticker-view',
      'blockchain-id.tr',
      'blockchain-id',
      'exchange.tr',
      'provider-id',
      'close',
      'type',
      'typespecs',
      'pricescale',
      'minmov',
      'fractional',
      'minmove2',
      'currency',
      '24h_close_change|5',
      'dex_txs_count_24h',
      'dex_trading_volume_24h',
      'dex_txs_count_uniq_24h',
      'dex_total_liquidity',
      'fully_diluted_value',
      'TechRating_1D',
      'TechRating_1D.tr',
    ],
    filter2: {
      operator: 'and',
      operands: [
        {
          operation: {
            operator: 'and',
            operands: [
              { expression: { left: 'centralization', operation: 'equal', right: 'dex' } },
              { expression: { left: 'currency_id', operation: 'equal', right: 'USD' } },
            ],
          },
        },
        {
          operation: {
            operator: 'or',
            operands: [
              {
                operation: {
                  operator: 'and',
                  operands: [
                    { expression: { left: 'type', operation: 'equal', right: 'spot' } },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
    sort: { sortBy: 'dex_txs_count_24h', sortOrder: 'desc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function crypto_dex(): Query {
  return cryptoDex()
}

export function forex(): Query {
  const q = new Query()
  q.url = scannerUrl('forex')
  q.query = {
    markets: ['forex'],
    symbols: {},
    options: { lang: 'en' },
    columns: ['name', 'close', 'volume', 'currency'],
    sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function futures(): Query {
  const q = new Query()
  q.url = scannerUrl('futures')
  q.query = {
    markets: ['futures'],
    symbols: {},
    options: { lang: 'en' },
    columns: ['name', 'close', 'volume', 'currency'],
    sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function bond(): Query {
  const q = new Query()
  q.url = scannerUrl('bond')
  q.query = {
    markets: ['bond'],
    symbols: {},
    options: { lang: 'en' },
    columns: [
      'ticker-view',
      'exchange.tr',
      'source-logoid',
      'isin-displayed',
      'yield_to_worst',
      'close_pct',
      'close_net',
      'type',
      'typespecs',
      'fundamental_currency_code',
      'current_coupon',
      'maturity_date',
      'redemption_type.tr',
      'bond_issuer_type.tr',
      'bond_snp_rating_lt.tr',
      'bond_fitch_rating_lt.tr',
    ],
    sort: { sortBy: 'bond_snp_rating_lt', sortOrder: 'desc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function cfd(): Query {
  const q = new Query()
  q.url = scannerUrl('cfd')
  q.query = {
    markets: ['cfd'],
    symbols: {},
    options: { lang: 'en' },
    columns: ['name', 'close', 'volume', 'currency'],
    sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
    range: [...DEFAULT_RANGE],
    ignore_unknown_fields: false,
  }
  return q
}

export function options(underlying: string): Query {
  const q = new Query()
  q.url = OPTIONS_SCAN2_URL
  q.query = {
    columns: [
      'ask',
      'bid',
      'currency',
      'delta',
      'expiration',
      'gamma',
      'iv',
      'option-type',
      'pricescale',
      'rho',
      'root',
      'strike',
      'theoPrice',
      'theta',
      'vega',
      'bid_iv',
      'ask_iv',
    ],
    filter2: {
      operator: 'and',
      operands: [{ expression: { left: 'type', operation: 'equal', right: 'option' } }],
    },
    ignore_unknown_fields: false,
    index_filters: [{ name: 'underlying_symbol', values: [underlying] }],
    options: { lang: 'en' },
    range: [...DEFAULT_RANGE],
  }
  return q
}
