/**
 * Safe mathematical expression evaluation.
 *
 * Supports numbers, parentheses, +, -, *, /, and unary +/-.
 */
export function calculate(expression: string): number {
  try {
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      throw new Error(
        'Invalid expression: only numbers and basic operators allowed',
      );
    }

    const parser = new ExpressionParser(expression);
    const result = parser.parse();
    if (!Number.isFinite(result)) {
      throw new Error('Invalid calculation result');
    }
    return Math.round(result * 10000) / 10000;
  } catch (error) {
    throw new Error(
      `Calculation error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): number {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.index < this.input.length) {
      throw new Error(`Unexpected token "${this.input[this.index]}"`);
    }
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();

    while (true) {
      this.skipWhitespace();
      const char = this.peek();
      if (char === '+' || char === '-') {
        this.index += 1;
        const rhs = this.parseTerm();
        value = char === '+' ? value + rhs : value - rhs;
      } else {
        break;
      }
    }

    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();

    while (true) {
      this.skipWhitespace();
      const char = this.peek();
      if (char === '*' || char === '/') {
        this.index += 1;
        const rhs = this.parseFactor();
        value = char === '*' ? value * rhs : value / rhs;
      } else {
        break;
      }
    }

    return value;
  }

  private parseFactor(): number {
    this.skipWhitespace();
    const char = this.peek();

    if (char === '+') {
      this.index += 1;
      return this.parseFactor();
    }
    if (char === '-') {
      this.index += 1;
      return -this.parseFactor();
    }
    if (char === '(') {
      this.index += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      this.index += 1;
      return value;
    }

    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.index;
    let seenDigit = false;
    let seenDot = false;

    while (this.index < this.input.length) {
      const char = this.input[this.index];
      if (char >= '0' && char <= '9') {
        seenDigit = true;
        this.index += 1;
        continue;
      }
      if (char === '.') {
        if (seenDot) break;
        seenDot = true;
        this.index += 1;
        continue;
      }
      break;
    }

    if (!seenDigit) {
      const token = this.peek();
      throw new Error(
        token ? `Unexpected token "${token}"` : 'Unexpected end of expression',
      );
    }

    const raw = this.input.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid number "${raw}"`);
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.input.length && /\s/.test(this.input[this.index])) {
      this.index += 1;
    }
  }

  private peek(): string | undefined {
    return this.input[this.index];
  }
}
