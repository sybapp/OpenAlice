import { ZodError } from 'zod'

export function getValidationErrorPayload(err: unknown): { error: string; details: ZodError['issues'] } | null {
  if (!(err instanceof ZodError)) return null
  return {
    error: 'Validation failed',
    details: err.issues,
  }
}
