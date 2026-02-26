/**
 * Model factory — creates Vercel AI SDK LanguageModel instances from config.
 *
 * Reads ai-provider.json from disk on each call so that model
 * changes take effect without a restart.  Uses dynamic imports so unused
 * provider packages don't prevent startup.
 */

import type { LanguageModel } from 'ai'
import { readAIProviderConfig } from './config.js'

/** Result includes the model plus a cache key for change detection. */
export interface ModelFromConfig {
  model: LanguageModel
  /** `provider:modelId:baseUrl` — use this to detect config changes. */
  key: string
}

export async function createModelFromConfig(): Promise<ModelFromConfig> {
  const config = await readAIProviderConfig()
  const baseKey = `${config.provider}:${config.model}:${config.baseUrl ?? ''}`

  switch (config.provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const client = createAnthropic({ apiKey: config.apiKeys.anthropic || undefined, baseURL: config.baseUrl || undefined })
      return { model: client(config.model), key: baseKey }
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const client = createOpenAI({ apiKey: config.apiKeys.openai || undefined, baseURL: config.baseUrl || undefined })

      // RightCode Codex endpoint currently returns SSE for responses API calls.
      // Force chat-completions path so Vercel AI SDK can parse responses reliably.
      if (isRightCodeCodexBaseUrl(config.baseUrl)) {
        return { model: client.chat(config.model), key: `${baseKey}:chat` }
      }

      return { model: client(config.model), key: `${baseKey}:responses` }
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const client = createGoogleGenerativeAI({ apiKey: config.apiKeys.google || undefined, baseURL: config.baseUrl || undefined })
      return { model: client(config.model), key: baseKey }
    }
    default:
      throw new Error(`Unsupported model provider: "${config.provider}". Supported: anthropic, openai, google`)
  }
}

function isRightCodeCodexBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false
  return /right\.codes\/codex\/v1\/?$/i.test(baseUrl)
}
