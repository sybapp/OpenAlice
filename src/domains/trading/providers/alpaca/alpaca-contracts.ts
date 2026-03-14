/**
 * Contract resolution helpers for Alpaca.
 *
 * Pure functions parameterized by provider string.
 */

import type { Contract } from '../../contract.js'
import type { Order } from '../../interfaces.js'

/** Build a fully qualified Contract for an Alpaca ticker. */
export function makeContract(ticker: string, provider: string): Contract {
  return {
    aliceId: `${provider}-${ticker}`,
    symbol: ticker,
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
  }
}

/** Extract native symbol from aliceId, or null if not ours. */
export function parseAliceId(aliceId: string, provider: string): string | null {
  const prefix = `${provider}-`
  if (!aliceId.startsWith(prefix)) return null
  return aliceId.slice(prefix.length)
}

/**
 * Resolve a Contract to an Alpaca ticker symbol.
 * Accepts: aliceId, or symbol (+ optional secType check).
 */
export function resolveSymbol(contract: Contract, provider: string): string | null {
  if (contract.aliceId) {
    return parseAliceId(contract.aliceId, provider)
  }
  if (contract.symbol) {
    // If secType is specified and not STK, not our domain
    if (contract.secType && contract.secType !== 'STK') return null
    return contract.symbol.toUpperCase()
  }
  return null
}

export function mapAlpacaOrderStatus(alpacaStatus: string): Order['status'] {
  switch (alpacaStatus) {
    case 'filled':
      return 'filled'
    case 'new':
    case 'accepted':
    case 'pending_new':
    case 'accepted_for_bidding':
      return 'pending'
    case 'canceled':
    case 'expired':
    case 'replaced':
      return 'cancelled'
    case 'partially_filled':
      return 'partially_filled'
    case 'done_for_day':
    case 'suspended':
    case 'rejected':
      return 'rejected'
    default:
      return 'pending'
  }
}
