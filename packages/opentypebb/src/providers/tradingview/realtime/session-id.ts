const randomAlphabet = 'abcdefghijklmnopqrstuvwxyz'

function randomSuffix(length: number): string {
  let suffix = ''
  for (let index = 0; index < length; index += 1) {
    suffix += randomAlphabet[Math.floor(Math.random() * randomAlphabet.length)]
  }
  return suffix
}

export function createSessionId(prefix: string): string {
  return `${prefix}_${randomSuffix(12)}`
}
