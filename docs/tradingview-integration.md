# TradingView 集成文档

## 概述

OpenAlice 通过 `@traderalice/opentypebb` 包深度集成 TradingView 的市场数据和实时行情服务，提供：
- **实时 WebSocket 连接**：Quote、Chart、Study 会话
- **市场扫描器**：预设筛选和自定义查询
- **技术分析**：TradingView 推荐指标
- **Pine Script 指标**：运行自定义和内置指标

## 架构

```
packages/opentypebb/src/providers/tradingview/
├── realtime/              # WebSocket 实时协议
│   ├── client.ts          # TradingViewRealtimeClient
│   ├── quote-session.ts   # 实时报价
│   ├── chart-session.ts   # K线图表
│   ├── study-session.ts   # 技术指标
│   └── graphic-parser.ts  # 图形数据解析器
├── scanner/               # 市场扫描器
│   ├── query.ts           # Query 构建器
│   ├── presets.ts         # 预设扫描
│   └── indicators.ts      # 指标元数据
└── index.ts
```

## 实时协议

### 帧格式

TradingView 使用自定义帧格式：

```
~m~<length>~m~<json_payload>
```

示例：
```
~m~43~m~{"m":"quote_create_session","p":["qs_1"]}
```

### WebSocket 连接

```typescript
import { tradingview } from '@traderalice/opentypebb'

const client = new tradingview.TradingViewRealtimeClient({
  server: 'data',  // 'data' | 'prodata' | 'widgetdata'
  credentials: { sessionid: 'xxx', sessionid_sign: 'xxx' },
})

await client.connect()
```

**服务器选择**：
- `data`：免费数据（15分钟延迟）
- `prodata`：付费实时数据（需订阅）
- `widgetdata`：widget 专用

### Quote Session（实时报价）

```typescript
const session = client.quoteSession('qs_1')

session.addSymbols(['NASDAQ:AAPL', 'BINANCE:BTCUSDT'], {
  preset: 'quote_base',  // 或 customFields: [...]
})

session.on('data', (data) => {
  console.log(data)
  // { v: { lp: 150.25, ch: 2.5, chp: 1.69, ... } }
})

// 稍后移除
session.removeSymbols(['NASDAQ:AAPL'])

// 清理
session.destroy()
```

**预设字段**：
- `quote_base`：基础报价（价格、涨跌）
- `quote_extended`：扩展字段（成交量、市值）
- `quote_full`：完整字段

**自定义字段**：
```typescript
session.addSymbols(['NASDAQ:AAPL'], {
  customFields: ['lp', 'volume', 'high', 'low', 'close'],
})
```

### Chart Session（K线图表）

```typescript
const session = client.chartSession('cs_1')

session.setMarket('NASDAQ:AAPL', {
  timeframe: '60',  // 1小时
  range: 300,       // 300根K线
})

session.on('update', (update) => {
  console.log('Candles:', update.candles)
  // [{ time: 1234567890, open: 150, high: 152, low: 149, close: 151, volume: 1000000 }]
})

// 切换时间周期
session.setSeries('D', 100)  // 日线，100根

// 切换 symbol
session.setMarket('BINANCE:BTCUSDT')

session.destroy()
```

**Timeframe 格式**：
- `'1'` - 1分钟
- `'60'` - 1小时
- `'D'` - 日线
- `'W'` - 周线
- `'M'` - 月线

### Study Session（技术指标）

#### 内置指标

```typescript
const session = client.studySession('ss_1')

session.setMarket('NASDAQ:AAPL', {
  timeframe: 'D',
  range: 100,
})

const rsi = new tradingview.TradingViewBuiltInIndicator('RSI@tv-basicstudies')
rsi.setOption('length', 14)

session.addStudy(rsi)

session.on('update', (update) => {
  if (update.studies.length > 0) {
    const study = update.studies[0]
    console.log('RSI values:', study.plots)
    // { plot_0: [{ $time: 1234567890, $value: 65.23 }, ...] }
  }
})

session.destroy()
```

**常用内置指标**：
- `RSI@tv-basicstudies` - 相对强弱指标
- `MASimple@tv-basicstudies` - 简单移动平均
- `MAExp@tv-basicstudies` - 指数移动平均
- `BB@tv-basicstudies` - 布林带
- `MACD@tv-basicstudies` - MACD
- `Stochastic@tv-basicstudies` - 随机指标

#### Pine Script 自定义指标

```typescript
const indicator = new tradingview.TradingViewPineIndicator({
  id: 'PUB;abc123',
  version: '1',
})

indicator.setOption('input_1', 20)  // 设置输入参数

session.addStudy(indicator)
```

查找 Pine 指标：
```typescript
const results = await tradingview.searchIndicators({
  query: 'volume profile',
  includeBuiltIn: false,
})
```

### Graphic Parser（图形解析）

TradingView 返回的图形数据需要解析：

```typescript
import { parseStudyGraphics } from '@traderalice/opentypebb'

const graphicUpdate = // ... 从 WebSocket 收到
const parsed = parseStudyGraphics(graphicUpdate)

console.log(parsed.text)  // 提取的文本标签
console.log(parsed.shapes) // 形状数据
```

## 市场扫描器

### 预设扫描

```typescript
import { tradingview } from '@traderalice/opentypebb'

const query = tradingview.stocks('america')
  .orderBy('volume', 'desc')
  .limit(50)

const scanner = new tradingview.Scanner()
const results = await scanner.scan(query, {
  columns: ['name', 'close', 'volume', 'market_cap_basic'],
})

console.log(results.data)
```

**可用预设**：
- `stocks(market?)` - 股票
- `crypto()` - 加密货币
- `cryptoDex()` - DEX 交易对
- `forex()` - 外汇
- `futures()` - 期货
- `bond()` - 债券
- `cfd()` - 差价合约
- `options(underlying)` - 期权

### 自定义查询

```typescript
const query = new tradingview.Query()
  .markets(['america'])
  .symbols({ query: { types: ['stock'] }, tickers: [] })
  .filter('volume', 'greater', 1000000)
  .filter('close', 'in_range', [50, 200])
  .orderBy('market_cap_basic', 'desc')
  .limit(100)

const results = await scanner.scan(query)
```

### 列映射

TradingView 内部列名 → 标准名称：

```typescript
const COLUMN_MAP = {
  'name': 'description',
  'close': 'close',
  'change': 'change',
  'change_abs': 'change_abs',
  'Recommend.All': 'Recommend.All',
  'volume': 'volume',
  'market_cap_basic': 'market_cap_basic',
  'price_earnings_ttm': 'price_earnings_ttm',
  'earnings_per_share_diluted_ttm': 'earnings_per_share_diluted_ttm',
  // ... 20+ 更多指标
}
```

## 技术分析推荐

```typescript
const analysis = await tradingview.technicalAnalysis('NASDAQ:AAPL', {
  periods: ['1m', '5m', '15m', '1h', '4h', '1d', '1W', '1M'],
})

console.log(analysis)
// {
//   '1d': { summary: 'BUY', oscillators: 'NEUTRAL', ma: 'BUY', ... },
//   '1W': { summary: 'STRONG_BUY', ... }
// }
```

**推荐值**：
- `STRONG_BUY` - 强烈买入
- `BUY` - 买入
- `NEUTRAL` - 中性
- `SELL` - 卖出
- `STRONG_SELL` - 强烈卖出

## Symbol 搜索

```typescript
const results = await tradingview.searchSymbol('AAPL', {
  type: 'stock',
  limit: 10,
})

console.log(results)
// [
//   { symbol: 'NASDAQ:AAPL', description: 'Apple Inc', type: 'stock', exchange: 'NASDAQ' },
//   { symbol: 'XETRA:APC', description: 'Apple Inc', type: 'stock', exchange: 'XETRA' },
//   ...
// ]
```

## 认证

### Session Cookies

TradingView 需要有效的 session cookies：

```typescript
const credentials = {
  sessionid: 'your_sessionid_cookie',
  sessionid_sign: 'your_sessionid_sign_cookie',
}
```

**获取方式**：
1. 登录 tradingview.com
2. 打开开发者工具 → Application → Cookies
3. 复制 `sessionid` 和 `sessionid_sign`

### 免费 vs 付费

| 功能 | 免费账户 | Pro/Premium |
|------|---------|-------------|
| 实时 Quote | ❌ (15分钟延迟) | ✅ |
| Chart Session | ✅ | ✅ |
| Scanner | ✅ (限制) | ✅ (完整) |
| 自定义指标 | ✅ | ✅ |
| 技术分析 | ✅ | ✅ |

## 错误处理

```typescript
client.on('error', (error) => {
  console.error('WebSocket error:', error)
})

session.on('error', (error) => {
  console.error('Session error:', error)
})

// 超时处理
const timeoutMs = 10000
const controller = new AbortController()
setTimeout(() => controller.abort(), timeoutMs)

try {
  await client.connect({ signal: controller.signal })
} catch (err) {
  if (err.name === 'AbortError') {
    console.error('Connection timeout')
  }
}
```

## 最佳实践

### 1. 连接复用

```typescript
// ✅ 好：复用单一 client
const client = new TradingViewRealtimeClient(...)
await client.connect()

const quote1 = client.quoteSession('qs_1')
const quote2 = client.quoteSession('qs_2')
const chart = client.chartSession('cs_1')

// ❌ 差：每个会话新建 client
```

### 2. 会话清理

```typescript
// 使用完毕后清理
session.destroy()

// 应用退出时关闭连接
await client.close()
```

### 3. 错误恢复

```typescript
session.on('error', (err) => {
  console.error('Session error:', err)
  
  // 重连逻辑
  setTimeout(async () => {
    session.destroy()
    const newSession = client.quoteSession('qs_new')
    // ... 重新订阅
  }, 5000)
})
```

### 4. 内存管理

```typescript
// 监听器包裹错误处理，防止内存泄漏
session.on('update', (update) => {
  try {
    processUpdate(update)
  } catch (err) {
    console.error('Update processing error:', err)
  }
})
```

## 性能优化

- **批量订阅**：一次 `addSymbols` 调用多个 symbol
- **合理的 range**：不要请求过多历史数据（建议 ≤300）
- **移除不需要的订阅**：及时 `removeSymbols`
- **字段选择**：使用 `customFields` 只订阅需要的字段

## 测试

```bash
# 单元测试
pnpm test packages/opentypebb/src/providers/tradingview/__tests__

# 集成测试需要真实凭据
TRADINGVIEW_SESSIONID=xxx pnpm test --run tradingview.integration.spec.ts
```

## 相关资源

- [TradingView API 文档](https://www.tradingview.com/rest-api-spec/)（官方）
- [Pine Script 参考](https://www.tradingview.com/pine-script-reference/)
- [Market Data Service](./market-data-service.md)
