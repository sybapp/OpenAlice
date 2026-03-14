import { Suspense, lazy, useState } from 'react'
import type { StreamingToolCall, ToolCall } from '../api'

interface ChatMessageProps {
  role: 'user' | 'assistant' | 'notification'
  text: string
  timestamp?: string | number | null
  /** True when this message follows another message of the same role — hides the label/avatar */
  isGrouped?: boolean
  media?: Array<{ type: string; url: string }>
}

const MarkdownMessage = lazy(async () => {
  const mod = await import('./MarkdownMessage')
  return { default: mod.MarkdownMessage }
})

function AliceAvatar() {
  return (
    <div className="w-6 h-6 rounded-full bg-accent/15 flex items-center justify-center text-accent shrink-0">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
    </div>
  )
}

export function ChatMessage({ role, text, timestamp, isGrouped, media }: ChatMessageProps) {
  if (role === 'notification') {
    return (
      <div className="flex flex-col items-center message-enter">
        <div className="max-w-[90%] px-4 py-2.5 bg-notification-bg border border-notification-border rounded-lg text-[13px] break-words">
          <Suspense fallback={<div className="whitespace-pre-wrap leading-relaxed">{text}</div>}>
            <MarkdownMessage text={text} media={media} prefixText={'🔔 '} />
          </Suspense>
        </div>
      </div>
    )
  }

  if (role === 'user') {
    return (
      <div className="flex flex-col items-end message-enter group">
        <div className="max-w-[75%] px-4 py-3 bg-user-bubble rounded-2xl rounded-br-sm break-words">
          <span className="whitespace-pre-wrap leading-relaxed">{text}</span>
        </div>
        {timestamp && (
          <div className="text-[11px] text-text-muted mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {new Date(timestamp).toLocaleString()}
          </div>
        )}
      </div>
    )
  }

  // Assistant
  return (
    <div className="flex flex-col items-start message-enter group">
      {!isGrouped && (
        <div className="flex items-center gap-2 mb-1.5">
          <AliceAvatar />
          <span className="text-[12px] text-text-muted font-medium">Alice</span>
        </div>
      )}
      <div className="max-w-[90%] break-words leading-relaxed ml-8">
        <Suspense fallback={<div className="whitespace-pre-wrap leading-relaxed">{text}</div>}>
          <MarkdownMessage text={text} media={media} />
        </Suspense>
      </div>
      {timestamp && (
        <div className="text-[11px] text-text-muted mt-1 ml-8 opacity-0 group-hover:opacity-100 transition-opacity">
          {new Date(timestamp).toLocaleString()}
        </div>
      )}
    </div>
  )
}

// ==================== Tool Call Group ====================

interface ToolCallGroupProps {
  calls: ToolCall[]
  timestamp?: string | null
}

export function ToolCallGroup({ calls, timestamp }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false)

  const summary = calls.map((c) => c.name).join(', ')

  return (
    <div className="flex flex-col items-start ml-8">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-bg-secondary border border-border text-text-muted text-[12px] hover:text-text hover:border-accent/40 transition-colors cursor-pointer select-none"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="truncate max-w-[400px]">{summary}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-1 ml-1 border-l-2 border-border pl-3 flex flex-col gap-2 py-1">
          {calls.map((call, i) => (
            <div key={i} className="text-[12px]">
              <div className="text-text-muted font-medium">{call.name}</div>
              <pre className="text-[11px] text-text-muted/70 font-mono whitespace-pre-wrap break-all mt-0.5 leading-relaxed">{call.input}</pre>
              {call.result && (
                <pre className="text-[11px] text-green/80 font-mono whitespace-pre-wrap break-all mt-0.5 leading-relaxed">{call.result}</pre>
              )}
            </div>
          ))}
        </div>
      )}

      {timestamp && (
        <div className="text-[11px] text-text-muted mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {new Date(timestamp).toLocaleString()}
        </div>
      )}
    </div>
  )
}

interface ThinkingIndicatorProps {
  isGrouped?: boolean
}

export function ThinkingIndicator({ isGrouped = false }: ThinkingIndicatorProps) {
  return (
    <div className="flex flex-col items-start message-enter">
      {!isGrouped && (
        <div className="flex items-center gap-2 mb-1.5">
          <AliceAvatar />
          <span className="text-[12px] text-text-muted font-medium">Alice</span>
        </div>
      )}
      <div className={`text-text-muted ${isGrouped ? 'ml-8' : 'ml-8'}`}>
        <div className="flex">
          <span className="thinking-dot">.</span>
          <span className="thinking-dot">.</span>
          <span className="thinking-dot">.</span>
        </div>
      </div>
    </div>
  )
}

interface StreamingToolGroupProps {
  calls: StreamingToolCall[]
}

export function StreamingToolGroup({ calls }: StreamingToolGroupProps) {
  return (
    <div className="flex flex-col items-start ml-8 gap-2">
      {calls.map((call) => (
        <div key={call.id} className="w-full max-w-[90%] rounded-lg border border-border bg-bg-secondary/60 px-3 py-2">
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <span className="inline-flex h-4 w-4 items-center justify-center">
              {call.status === 'running' ? (
                <span className="h-2.5 w-2.5 rounded-full border border-accent/70 border-t-transparent animate-spin" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
            <span className="font-medium text-text">{call.name}</span>
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-text-muted/80">{call.input}</pre>
          {call.result && (
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-green/80">{call.result}</pre>
          )}
        </div>
      ))}
    </div>
  )
}
