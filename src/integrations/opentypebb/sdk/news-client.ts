/**
 * SDK News Client
 *
 * Drop-in replacement for OpenBBNewsClient.
 */

import { SDKBaseClient } from './base-client.js'

export class SDKNewsClient extends SDKBaseClient {
  async getWorldNews(params: Record<string, unknown> = {}) {
    return this.request('/world', params)
  }

  async getCompanyNews(params: Record<string, unknown>) {
    return this.request('/company', params)
  }
}
