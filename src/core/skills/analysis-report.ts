import { z } from 'zod'

export const analysisReportSchema = z.object({
  skillId: z.string(),
  symbol: z.string(),
  marketCondition: z.string(),
  bias: z.string(),
  confidence: z.number().min(0).max(1),
  thesis: z.array(z.string()),
  evidence: z.array(z.string()),
  timeframe: z.string().optional(),
  setupQuality: z.string().optional(),
  keyLevels: z.array(z.string()).optional(),
  tradeIdea: z.string().optional(),
  invalidation: z.array(z.string()).optional(),
})

export type AnalysisReport = z.infer<typeof analysisReportSchema>

export const ANALYSIS_REPORT_NAME = 'AnalysisReport'

export const ANALYSIS_REPORT_INSTRUCTIONS = [
  'Return an analysis that can be mapped to the AnalysisReport contract.',
  'Required fields: skillId, symbol, marketCondition, bias, confidence, thesis[], evidence[].',
  'Optional fields: timeframe, setupQuality, keyLevels[], tradeIdea, invalidation[].',
  'Prefer a concise Markdown summary followed by a structured AnalysisReport block.',
].join(' ')
