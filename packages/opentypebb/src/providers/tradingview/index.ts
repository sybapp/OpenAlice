import { Provider } from '../../core/provider/abstract/provider.js'
import * as scanner from './scanner/index.js'

export { scanner }
export * from './scanner/index.js'

export const tradingviewProvider = new Provider({
  name: 'tradingview',
  website: 'https://www.tradingview.com',
  description:
    'TradingView scanner provides market screener data across stocks, crypto, forex, futures, bonds, CFDs, and options.',
  reprName: 'TradingView',
  fetcherDict: {},
})
