import type { SaveStatus } from '../hooks/useAutoSave'

const STATUS_CONTENT: Partial<Record<SaveStatus, { dotClass: string; textClass: string; label: string }>> = {
  saving: {
    dotClass: 'bg-accent animate-pulse',
    textClass: 'text-text-muted',
    label: 'Saving…',
  },
  saved: {
    dotClass: 'bg-green',
    textClass: 'text-text-muted',
    label: 'Saved',
  },
  applying: {
    dotClass: 'bg-accent animate-pulse',
    textClass: 'text-text-muted',
    label: 'Applying changes...',
  },
  error: {
    dotClass: 'bg-red',
    textClass: 'text-red',
    label: 'Save failed',
  },
}

export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry?: () => void }) {
  if (status === 'idle') return null
  const content = STATUS_CONTENT[status]
  if (!content) return null

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] shrink-0">
      <span className={`w-1.5 h-1.5 rounded-full ${content.dotClass}`} />
      <span className={content.textClass}>{content.label}</span>
      {status === 'error' && onRetry && (
        <>
          <button
            onClick={onRetry}
            className="text-red underline underline-offset-2 hover:text-text ml-0.5"
          >
            Retry
          </button>
        </>
      )}
    </span>
  )
}
