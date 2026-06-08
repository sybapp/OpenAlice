import type { FilterOperation } from './types.js'

type ColumnValue = Column | unknown

export class Column {
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  private static extractName(value: ColumnValue): unknown {
    return value instanceof Column ? value.name : value
  }

  gt(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'greater', right: Column.extractName(other) }
  }

  gte(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'egreater', right: Column.extractName(other) }
  }

  lt(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'less', right: Column.extractName(other) }
  }

  lte(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'eless', right: Column.extractName(other) }
  }

  eq(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'equal', right: Column.extractName(other) }
  }

  ne(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'nequal', right: Column.extractName(other) }
  }

  crosses(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'crosses', right: Column.extractName(other) }
  }

  crossesAbove(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'crosses_above', right: Column.extractName(other) }
  }

  crossesBelow(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'crosses_below', right: Column.extractName(other) }
  }

  between(left: ColumnValue, right: ColumnValue): FilterOperation {
    return {
      left: this.name,
      operation: 'in_range',
      right: [Column.extractName(left), Column.extractName(right)],
    }
  }

  notBetween(left: ColumnValue, right: ColumnValue): FilterOperation {
    return {
      left: this.name,
      operation: 'not_in_range',
      right: [Column.extractName(left), Column.extractName(right)],
    }
  }

  isin(values: Iterable<unknown>): FilterOperation {
    return { left: this.name, operation: 'in_range', right: [...values] }
  }

  notIn(values: Iterable<unknown>): FilterOperation {
    return { left: this.name, operation: 'not_in_range', right: [...values] }
  }

  has(values: string | string[]): FilterOperation {
    return { left: this.name, operation: 'has', right: values }
  }

  hasNoneOf(values: string | string[]): FilterOperation {
    return { left: this.name, operation: 'has_none_of', right: values }
  }

  inDayRange(a: number, b: number): FilterOperation {
    return { left: this.name, operation: 'in_day_range', right: [a, b] }
  }

  inWeekRange(a: number, b: number): FilterOperation {
    return { left: this.name, operation: 'in_week_range', right: [a, b] }
  }

  inMonthRange(a: number, b: number): FilterOperation {
    return { left: this.name, operation: 'in_month_range', right: [a, b] }
  }

  abovePct(column: Column | string, pct: number): FilterOperation {
    return {
      left: this.name,
      operation: 'above%',
      right: [Column.extractName(column), pct],
    }
  }

  belowPct(column: Column | string, pct: number): FilterOperation {
    return {
      left: this.name,
      operation: 'below%',
      right: [Column.extractName(column), pct],
    }
  }

  betweenPct(column: Column | string, pct1: number, pct2: number | null = null): FilterOperation {
    return {
      left: this.name,
      operation: 'in_range%',
      right: [Column.extractName(column), pct1, pct2],
    }
  }

  notBetweenPct(column: Column | string, pct1: number, pct2: number | null = null): FilterOperation {
    return {
      left: this.name,
      operation: 'not_in_range%',
      right: [Column.extractName(column), pct1, pct2],
    }
  }

  like(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'match', right: Column.extractName(other) }
  }

  notLike(other: ColumnValue): FilterOperation {
    return { left: this.name, operation: 'nmatch', right: Column.extractName(other) }
  }

  empty(): FilterOperation {
    return { left: this.name, operation: 'empty', right: null }
  }

  notEmpty(): FilterOperation {
    return { left: this.name, operation: 'nempty', right: null }
  }

  crosses_above(other: ColumnValue): FilterOperation {
    return this.crossesAbove(other)
  }

  crosses_below(other: ColumnValue): FilterOperation {
    return this.crossesBelow(other)
  }

  not_between(left: ColumnValue, right: ColumnValue): FilterOperation {
    return this.notBetween(left, right)
  }

  not_in(values: Iterable<unknown>): FilterOperation {
    return this.notIn(values)
  }

  has_none_of(values: string | string[]): FilterOperation {
    return this.hasNoneOf(values)
  }

  in_day_range(a: number, b: number): FilterOperation {
    return this.inDayRange(a, b)
  }

  in_week_range(a: number, b: number): FilterOperation {
    return this.inWeekRange(a, b)
  }

  in_month_range(a: number, b: number): FilterOperation {
    return this.inMonthRange(a, b)
  }

  above_pct(column: Column | string, pct: number): FilterOperation {
    return this.abovePct(column, pct)
  }

  below_pct(column: Column | string, pct: number): FilterOperation {
    return this.belowPct(column, pct)
  }

  between_pct(column: Column | string, pct1: number, pct2: number | null = null): FilterOperation {
    return this.betweenPct(column, pct1, pct2)
  }

  not_between_pct(column: Column | string, pct1: number, pct2: number | null = null): FilterOperation {
    return this.notBetweenPct(column, pct1, pct2)
  }

  not_like(other: ColumnValue): FilterOperation {
    return this.notLike(other)
  }

  not_empty(): FilterOperation {
    return this.notEmpty()
  }
}

export const col = (name: string): Column => new Column(name)
