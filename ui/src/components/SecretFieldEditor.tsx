import type { ReactNode } from 'react'
import { inputClass } from './form'
import { SecretStatusPill } from './SecretStatusPill'

export function SecretFieldEditor({
  configured,
  value,
  onChange,
  onSet,
  onClear,
  setDisabled,
  clearDisabled,
  inputAriaLabel,
  setAriaLabel,
  clearAriaLabel,
  configuredLabel,
  emptyLabel,
  configuredPlaceholder,
  emptyPlaceholder,
  configuredSetLabel,
  emptySetLabel,
  clearLabel,
  error,
  inputTrailing,
}: {
  configured: boolean
  value: string
  onChange: (value: string) => void
  onSet: () => void
  onClear: () => void
  setDisabled: boolean
  clearDisabled: boolean
  inputAriaLabel: string
  setAriaLabel: string
  clearAriaLabel: string
  configuredLabel?: string
  emptyLabel?: string
  configuredPlaceholder: string
  emptyPlaceholder: string
  configuredSetLabel: string
  emptySetLabel: string
  clearLabel: string
  error?: string | null
  inputTrailing?: ReactNode
}) {
  return (
    <div className="space-y-2">
      <SecretStatusPill
        configured={configured}
        configuredLabel={configuredLabel}
        emptyLabel={emptyLabel}
      />
      <div className={inputTrailing ? 'flex items-center gap-2' : undefined}>
        <input
          className={inputClass}
          type="password"
          aria-label={inputAriaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={configured ? configuredPlaceholder : emptyPlaceholder}
        />
        {inputTrailing}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onSet}
          aria-label={setAriaLabel}
          disabled={setDisabled}
          className="rounded-lg border border-border px-3 py-2 text-[12px] font-medium text-text transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {configured ? configuredSetLabel : emptySetLabel}
        </button>
        <button
          onClick={onClear}
          aria-label={clearAriaLabel}
          disabled={clearDisabled}
          className="rounded-lg border border-border px-3 py-2 text-[12px] font-medium text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {clearLabel}
        </button>
      </div>
      {error && <p className="text-[11px] text-red">{error}</p>}
    </div>
  )
}
