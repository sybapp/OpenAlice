export function SecretStatusPill({
  configured,
  configuredLabel = 'Configured',
  emptyLabel = 'Not configured',
}: {
  configured: boolean
  configuredLabel?: string
  emptyLabel?: string
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
        configured
          ? 'bg-accent/10 text-accent'
          : 'bg-bg-secondary text-text-muted'
      }`}
    >
      {configured ? configuredLabel : emptyLabel}
    </span>
  )
}
