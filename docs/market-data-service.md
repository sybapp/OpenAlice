# Market Data Service 架构文档

## 概述

Market Data Service 是 OpenAlice 的统一市场数据访问层，提供 provider-agnostic 的接口来查询股票、加密货币、外汇、商品等多资产类别的行情、财报、技术指标等数据。

**位置**：`src/services/market-data/`

**核心职责**：
- 统一多数据源（OpenTypeBB SDK、TradingView、OpenBB API）
- 资产类别抽象（equity/crypto/currency/commodity 共享接口）
- 协议适配（REST API、WebSocket、自定义帧格式）
- 数据标准化（返回统一的 envelope 结构）

## 架构设计

### 模块结构

```
services/market-data/
├── service.ts          # 主服务类 MarketDataService
├── types.ts            # 类型定义和常量
├── config.ts           # 配置常量（超时、限制等）
├── tradingview.ts      # TradingView 专用工具函数
├── sector-rotation.ts  # 板块轮动计算
└── indicator/          # 技术指标计算
    ├── calculator.ts   # 核心计算引擎
    ├── calculation.ts  # 多资产类别包装
    ├── types.ts        # 指标相关类型
    └── functions/      # 技术指标函数库
```

### 关键类型

```typescript
// 资产类别（9 种）
type MarketDataAssetClass = 
  'equity' | 'crypto' | 'currency' | 'commodity' |
  'etf' | 'index' | 'derivatives' | 'economy' | 'news'

// 统一返回结构
interface MarketDataEnvelope {
  provider: string
  endpoint: string
  totalCount: number
  fields: string[]
  rows: Array<Record<string, unknown>>
  warnings: string[]
  error?: string
}
```

## 核心功能

### 1. Catalog & Discovery

```typescript
const catalog = await service.catalog()
// 返回所有可用端点和 provider 信息

const result = await service.endpointSearch({
  query: 'income',
  assetClass: 'equity',
})
// 轻量级搜索，无需加载完整 catalog
```

### 2. 通用端点查询

```typescript
const result = await service.query({
  endpoint: '/equity/price/historical',
  params: { symbol: 'AAPL', start_date: '2024-01-01' },
  provider: 'yfinance',  // 可选覆盖
  limit: 100,
})
```

### 3. TradingView 专用功能

#### Scan（市场扫描）
```typescript
const result = await service.scan({
  preset: 'stocks',
  market: 'america',
  compact: true,
  limit: 50,
})
```

#### Symbol Search
```typescript
const result = await service.searchTradingViewSymbols({
  query: 'AAPL',
  limit: 10,
})
// 返回 TradingView-qualified symbol (e.g., "NASDAQ:AAPL")
```

#### Realtime Quote/Candles
```typescript
const result = await service.tradingViewQuote({
  symbol: 'NASDAQ:AAPL',
})

const result = await service.tradingViewCandles({
  symbol: 'NASDAQ:AAPL',
  options: { timeframe: '60', range: 100 },
})
```

#### Technical Analysis
```typescript
const result = await service.technicalAnalysis({
  symbol: 'NASDAQ:AAPL',
  periods: ['1d', '1w', '1M'],
})
// 返回 TradingView 的买入/卖出推荐
```

#### Study（指标计算）
```typescript
const result = await service.runTradingViewStudy({
  symbol: 'NASDAQ:AAPL',
  indicatorId: 'PUB;xyz',
  inputs: { length: 14 },
})
// 运行 Pine Script 自定义指标
```

### 4. 技术指标计算

```typescript
const result = await service.indicator({
  asset: 'equity',
  formula: "SMA(CLOSE('AAPL', '1d'), 50)",
  precision: 2,
})
// 返回 { value: number, dataRange: {...} }
```

支持的函数：
- 数据访问：`CLOSE`, `HIGH`, `LOW`, `OPEN`, `VOLUME`
- 统计：`SMA`, `EMA`, `STDEV`, `MAX`, `MIN`, `SUM`, `AVERAGE`
- 技术：`RSI`, `BBANDS`, `MACD`, `ATR`, `RVOL`, `OBV`, `MFI`, `VWAP`
- 算术：`+`, `-`, `*`, `/`

### 5. 财务数据

```typescript
// 财报
const result = await service.fundamentals({
  symbol: 'AAPL',
  statement: 'income',  // income | balance | cash | ratios | metrics
  limit: 8,
})

// 财报日历
const result = await service.earnings({
  symbol: 'AAPL',
  limit: 10,
})

// SEC 文件
const result = await service.filings({
  symbol: 'AAPL',
  limit: 20,
})
```

## 配置管理

### 常量配置（`config.ts`）

```typescript
export const TRADINGVIEW_CONFIG = {
  REALTIME_TIMEOUT_MS: 10_000,
  DEFAULT_CANDLE_RANGE: 300,
  DEFAULT_SCAN_LIMIT: 50,
  MAX_SCAN_LIMIT: 1000,
  SCAN_COMPACT_COLUMNS: [...],
}

export const MARKET_DATA_CONFIG = {
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 500,
}
```

### 运行时配置

Provider 配置来自 `core/config.ts`：

```typescript
marketData: {
  backend: 'sdk' | 'openbb-api',
  providers: {
    equity: 'yfinance',
    crypto: 'ccxt',
    currency: 'fmp',
    commodity: 'yfinance',
  },
  providerKeys: {
    fmp_api_key: 'xxx',
  },
}
```

## 数据流

```
┌─────────────┐
│   AI Tool   │
│ Layer       │
└─────┬───────┘
      │ createMarketDataTools(service)
      ▼
┌─────────────────────────────────┐
│  MarketDataService              │
│  ├─ catalog()                   │
│  ├─ query()                     │
│  ├─ scan()                      │
│  ├─ indicator()                 │
│  └─ tradingView*()              │
└─────┬───────────────────────────┘
      │
      ├──────────────┬──────────────┬───────────────┐
      ▼              ▼              ▼               ▼
┌──────────┐  ┌──────────┐  ┌─────────────┐  ┌──────────┐
│OpenTypeBB│  │TradingView│  │ OpenBB API │  │Indicator │
│   SDK    │  │  Realtime │  │  (remote)  │  │Calculator│
└──────────┘  └──────────┘  └─────────────┘  └──────────┘
      │              │              │               │
      └──────────────┴──────────────┴───────────────┘
                     ▼
              ┌────────────────┐
              │ Unified        │
              │ Envelope       │
              └────────────────┘
```

## Limit 执行策略

```typescript
function clampLimit(limit?: number): number {
  if (!limit) return MARKET_DATA_DEFAULT_LIMIT  // 50
  return Math.max(0, Math.min(MARKET_DATA_MAX_LIMIT, Math.floor(limit)))  // [0, 500]
}
```

所有查询接口的 `limit` 参数都经过此函数处理。

## 错误处理

### Envelope 错误
```typescript
{
  provider: 'tradingview',
  endpoint: '/equity/price/historical',
  rows: [],
  fields: [],
  totalCount: 0,
  warnings: [],
  error: 'Missing required parameter: symbol'
}
```

### 异常抛出
- 无效的 asset class
- 无效的指标公式语法
- 网络超时（可配置）

## 扩展指南

### 添加新的资产类别

1. 更新 `types.ts`：
```typescript
export const MARKET_DATA_ASSET_CLASSES = [
  // ... 现有类别
  'newAsset',
] as const
```

2. 更新 provider 配置结构（如需要）
3. 添加对应的客户端实现

### 添加新的 TradingView 端点

在 `tradingview.ts` 中扩展 `TRADINGVIEW_GENERIC_ENDPOINTS`：

```typescript
{
  endpoint: '/tradingview/new-feature',
  model: 'TradingViewNewFeature',
  description: '...',
  providers: ['tradingview'],
}
```

## 性能考虑

- **WebSocket 连接复用**：TradingView realtime 使用单一 client 实例
- **limit 保护**：防止单次查询过载（MAX_LIMIT = 500）
- **超时机制**：WebSocket 操作默认 10 秒超时
- **错误恢复**：监听器包裹错误处理，防止内存泄漏

## 测试

- **单元测试**：92 个（覆盖各模块独立功能）
- **集成测试**：8 个（覆盖端到端流程）

运行测试：
```bash
pnpm test src/services/market-data
```

## 相关文档

- [TradingView 集成文档](./tradingview-integration.md)
- [技术指标计算说明](./indicator-calculation.md)（待补充）
- [CLAUDE.md](../../CLAUDE.md) - 项目架构总览
