import { Provider } from '../../core/provider/abstract/provider.js'
import * as realtime from './realtime/index.js'
import * as scanner from './scanner/index.js'

export { realtime }
export { scanner }
export * from './realtime/index.js'
export * from './scanner/index.js'

export const tradingviewProvider = new Provider({
  name: 'tradingview',
  website: 'https://www.tradingview.com',
  description:
    'TradingView scanner provides market screener data across stocks, crypto, forex, futures, bonds, CFDs, and options.',
  reprName: 'TradingView',
  fetcherDict: {},
})
