import type { SessionEntry } from './session.js'

export interface PostCompactRehydration {
  isCompactContinuation: boolean
  summaryUuid?: string
  preservedEntryUuids: string[]
  preservedToolUseIds: string[]
  recallHint: string
}

export function rehydratePostCompactContext(entries: SessionEntry[]): PostCompactRehydration {
  const boundary = findLastCompactBoundary(entries)
  if (!boundary?.compactMetadata) {
    return {
      isCompactContinuation: false,
      preservedEntryUuids: [],
      preservedToolUseIds: [],
      recallHint: '',
    }
  }

  const preservedEntryUuids = boundary.compactMetadata.preservedEntryUuids ?? []
  const preservedToolUseIds = boundary.compactMetadata.preservedToolUseIds ?? []
  const preservedTexts = entries
    .filter((entry) => preservedEntryUuids.includes(entry.uuid))
    .map(entryText)
    .filter(Boolean)
    .join('\n')

  const recallHint = [
    boundary.compactMetadata.summaryUuid ? `compact summary uuid: ${boundary.compactMetadata.summaryUuid}` : '',
    preservedToolUseIds.length ? `preserved tool use ids: ${preservedToolUseIds.join(', ')}` : '',
    preservedTexts,
  ].filter(Boolean).join('\n')

  return {
    isCompactContinuation: true,
    summaryUuid: boundary.compactMetadata.summaryUuid,
    preservedEntryUuids,
    preservedToolUseIds,
    recallHint,
  }
}

function findLastCompactBoundary(entries: SessionEntry[]): SessionEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return entry
  }
  return undefined
}

function entryText(entry: SessionEntry): string {
  const content = entry.message.content
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool_use') return `${block.name} ${JSON.stringify(block.input)}`
    if (block.type === 'tool_result') return block.content
    return ''
  }).join('\n')
}
