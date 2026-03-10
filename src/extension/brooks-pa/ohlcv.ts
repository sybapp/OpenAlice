import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import type { AssetClass } from './types'
import { fetchOhlcvByBars } from '@/extension/indicator-kit/index'
import type { OhlcvData } from '@/extension/indicator-kit/index'

type ClientByAsset = {
  equityClient: OpenBBEquityClient
  cryptoClient: OpenBBCryptoClient
  currencyClient: OpenBBCurrencyClient
}

function pickClient(asset: AssetClass, clients: ClientByAsset) {
  switch (asset) {
    case 'equity': return clients.equityClient
    case 'crypto': return clients.cryptoClient
    case 'currency': return clients.currencyClient
  }
}

export async function getBarsByTf(params: {
  asset: AssetClass
  symbol: string
  interval: string
  lookbackBars: number
  clients: ClientByAsset
  paddingBars?: number
}): Promise<OhlcvData[]> {
  const { asset, symbol, interval, lookbackBars, clients, paddingBars } = params
  const client = pickClient(asset, clients)

  return await fetchOhlcvByBars({
    client,
    symbol,
    interval,
    lookbackBars,
    paddingBars,
  })
}
