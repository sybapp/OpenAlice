import { Provider } from '../../core/provider/abstract/provider.js'

export { Column, col } from './column.js'
export {
  And,
  DEFAULT_HEADERS,
  DEFAULT_RANGE,
  OPTIONS_SCAN2_URL,
  Or,
  Query,
  SCAN_URL,
  STOCKS_QUERY,
} from './query.js'
export {
  bond,
  cfd,
  coin,
  crypto,
  crypto_dex,
  cryptoDex,
  forex,
  futures,
  options,
  stocks,
} from './screeners.js'
export type {
  Expression,
  FilterOperation,
  Operation,
  OperationComparison,
  SortBy,
  Symbols,
  TradingViewCredentials,
  TradingViewQueryPayload,
  TradingViewRawResponse,
  TradingViewRequestOptions,
  TradingViewRow,
  TradingViewScannerData,
  TradingViewScan2RawResponse,
  TradingViewScan2Row,
  TradingViewScanRawResponse,
  TradingViewScanRow,
} from './types.js'

export const tradingviewProvider = new Provider({
  name: 'tradingview',
  website: 'https://www.tradingview.com',
  description:
    'TradingView scanner provides market screener data across stocks, crypto, forex, futures, bonds, CFDs, and options.',
  reprName: 'TradingView',
  fetcherDict: {},
})
