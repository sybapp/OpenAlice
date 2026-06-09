export interface OhlcvData {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  [key: string]: unknown
}

export interface DataSourceMeta {
  symbol: string
  from: string
  to: string
  bars: number
}

export interface HistoricalDataResult {
  data: OhlcvData[]
  meta: DataSourceMeta
}

export interface TrackedValues {
  values: number[]
  source: DataSourceMeta
}

export function toValues(input: number[] | TrackedValues): number[] {
  return Array.isArray(input) ? input : input.values
}

export interface IndicatorContext {
  getHistoricalData: (symbol: string, interval: string) => Promise<HistoricalDataResult>
}

export type CalculationResult = number | number[] | string | Record<string, number> | TrackedValues

export type ASTNode =
  | NumberNode
  | StringNode
  | ArrayNode
  | FunctionNode
  | BinaryOpNode
  | ArrayAccessNode

export interface NumberNode {
  type: 'number'
  value: number
}

export interface StringNode {
  type: 'string'
  value: string
}

export interface ArrayNode {
  type: 'array'
  value: number[]
}

export interface FunctionNode {
  type: 'function'
  name: string
  args: ASTNode[]
}

export interface BinaryOpNode {
  type: 'binaryOp'
  operator: '+' | '-' | '*' | '/'
  left: ASTNode
  right: ASTNode
}

export interface ArrayAccessNode {
  type: 'arrayAccess'
  array: ASTNode
  index: ASTNode
}
