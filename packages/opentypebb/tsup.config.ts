import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    tradingview: 'src/providers/tradingview/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  splitting: true,
})
