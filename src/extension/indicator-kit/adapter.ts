/**
 * Analysis Kit — 统一量化因子计算工具
 *
 * 通过 asset 参数区分资产类别（equity/crypto/currency），
 * 公式语法完全一样：CLOSE('AAPL', '1d')、SMA(...)、RSI(...) 等。
 * 数据带 TTL 内存缓存，同一 symbol+interval 在缓存有效期内只拉一次。
 */

import type { OpenBBEquityClient } from '@/openbb/equity/client'
import type { OpenBBCryptoClient } from '@/openbb/crypto/client'
import type { OpenBBCurrencyClient } from '@/openbb/currency/client'
import { createIndicatorTools } from '../indicator-tools/adapter'

/**
 * @deprecated moved to indicator-tools
 *
 * Kept only as a compatibility shim. Prefer:
 *   import { createIndicatorTools } from '@/extension/indicator-tools'
 */
export function createAnalysisTools(
  equityClient: OpenBBEquityClient,
  cryptoClient: OpenBBCryptoClient,
  currencyClient: OpenBBCurrencyClient,
) {
  return createIndicatorTools(equityClient, cryptoClient, currencyClient)
}
