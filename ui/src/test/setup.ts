function createMemoryStorage(): Storage {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

const storage =
  globalThis.window?.localStorage && typeof globalThis.window.localStorage.clear === 'function'
    ? globalThis.window.localStorage
    : createMemoryStorage()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
  writable: true,
})
