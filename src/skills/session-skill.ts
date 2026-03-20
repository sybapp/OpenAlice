import { randomUUID } from 'node:crypto'
import type { SessionEntry, SessionStore } from '../core/session.js'

export const SKILL_MARKER_KIND = 'skill'

export interface SessionSkillMarkerMetadata {
  kind: 'skill'
  profileId: string | null
}

export async function setSessionSkill(session: SessionStore, profileId: string | null): Promise<void> {
  const metadata: SessionSkillMarkerMetadata = {
    kind: 'skill',
    profileId,
  }
  const entry: SessionEntry = {
    type: 'system',
    message: { role: 'system', content: profileId ? `skill:${profileId}` : 'skill:off' },
    metadata: metadata as unknown as Record<string, unknown>,
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    provider: 'engine',
  }
  await session.appendRaw(entry)
}

export async function getSessionSkillId(session: SessionStore): Promise<string | null> {
  const entries = await session.readAll()
  return getSessionSkillIdFromEntries(entries)
}

export function getSessionSkillIdFromEntries(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const metadata = entries[i].metadata as SessionSkillMarkerMetadata | undefined
    if (entries[i].type === 'system' && metadata?.kind === SKILL_MARKER_KIND) {
      return metadata.profileId ?? null
    }
  }
  return null
}
