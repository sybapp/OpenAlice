/**
 * TradingView Graphic Parser
 *
 * Parses and normalizes drawing objects (labels, lines, boxes, tables, etc.)
 * created by Pine Script strategies and indicators on TradingView charts.
 *
 * ## Data Flow
 *
 * TradingView sends drawing commands over WebSocket in a compact, abbreviated format:
 * 1. `graphicsCmds` contains create/erase operations
 * 2. `applyTradingViewGraphicCommands` updates the store with these commands
 * 3. `parseTradingViewGraphics` transforms the abbreviated format into readable objects
 *
 * ## Abbreviation Mapping
 *
 * TradingView uses short keys to minimize WebSocket payload size:
 * - `ci` → color index
 * - `tci` → text color index
 * - `st` → style
 * - `ex` → extend
 * - `yl` → y location
 * - `sz` → size
 * - `ta` → text align
 * - `tt` → tooltip
 * - etc.
 *
 * The `translator` maps abbreviated enum values to readable names:
 * - `extend: { r: 'right', l: 'left', b: 'both', n: 'none' }`
 * - `yLoc: { pr: 'price', ab: 'abovebar', bl: 'belowbar' }`
 * - etc.
 *
 * ## Index Resolution
 *
 * X-coordinates for time-based objects are sent as integer indexes into a
 * separate time array, not as timestamps. The `indexes` array maps these
 * integer indexes back to actual timestamps or bar indexes.
 */

type Translator = Record<string, Record<string, string>>

/**
 * Translators for abbreviated enum values sent by TradingView.
 *
 * These mappings convert compact wire format to readable property values:
 * - extend: line/box extension behavior (right, left, both, none)
 * - yLoc: vertical positioning for labels (price level, above/below bar)
 * - labelStyle: marker shapes (arrows, triangles, flags, labels, etc.)
 * - lineStyle: line rendering style (solid, dotted, dashed, arrows)
 * - boxStyle: box border style (solid, dotted, dashed)
 */
const translator: Translator = {
  extend: { r: 'right', l: 'left', b: 'both', n: 'none' },
  yLoc: { pr: 'price', ab: 'abovebar', bl: 'belowbar' },
  labelStyle: {
    n: 'none',
    xcr: 'xcross',
    cr: 'cross',
    tup: 'triangleup',
    tdn: 'triangledown',
    flg: 'flag',
    cir: 'circle',
    aup: 'arrowup',
    adn: 'arrowdown',
    lup: 'label_up',
    ldn: 'label_down',
    llf: 'label_left',
    lrg: 'label_right',
    llwlf: 'label_lower_left',
    llwrg: 'label_lower_right',
    luplf: 'label_upper_left',
    luprg: 'label_upper_right',
    lcn: 'label_center',
    sq: 'square',
    dia: 'diamond',
  },
  lineStyle: { sol: 'solid', dot: 'dotted', dsh: 'dashed', al: 'arrow_left', ar: 'arrow_right', ab: 'arrow_both' },
  boxStyle: { sol: 'solid', dot: 'dotted', dsh: 'dashed' },
}

/**
 * Raw storage format for TradingView graphic objects.
 *
 * Structure: `{ [type: string]: { [id: string]: drawing } }`
 *
 * Types include:
 * - dwglabels: text labels on the chart
 * - dwglines: trend lines, arrows
 * - dwgboxes: rectangles with optional text
 * - dwgtables: multi-cell tables
 * - dwgtablecells: individual table cells (keyed by parent table id)
 * - horizlines: horizontal price levels
 * - polygons: multi-point shapes
 * - hhists: horizontal histograms (price distribution)
 */
export type TradingViewGraphicStore = Record<string, Record<string, Record<string, unknown>>>

/**
 * Normalized, user-facing representation of all graphic objects on a chart.
 *
 * Each array contains parsed objects with readable property names and
 * resolved indexes. The `raw` field preserves the original store for
 * debugging or advanced use cases.
 */
export interface TradingViewGraphicData {
  labels: Record<string, unknown>[]
  lines: Record<string, unknown>[]
  boxes: Record<string, unknown>[]
  tables: Array<Record<string, unknown> & { cells: Record<string, unknown>[][] }>
  textItems: Record<string, unknown>[]
  plainText: string[]
  horizLines: Record<string, unknown>[]
  polygons: Record<string, unknown>[]
  horizHists: Record<string, unknown>[]
  raw: TradingViewGraphicStore
}

export function emptyTradingViewGraphics(): TradingViewGraphicData {
  return {
    labels: [],
    lines: [],
    boxes: [],
    tables: [],
    textItems: [],
    plainText: [],
    horizLines: [],
    polygons: [],
    horizHists: [],
    raw: {},
  }
}

/**
 * Extract all drawings of a given type from the store.
 *
 * Returns an array of drawing objects, or empty array if the type doesn't exist.
 */
function values(source: TradingViewGraphicStore, type: string): Record<string, unknown>[] {
  return Object.values(source[type] ?? {})
}

/**
 * Translate an abbreviated enum value to its readable form.
 *
 * Example: translate('extend', 'r') → 'right'
 *
 * Returns the original value if no translation exists.
 */
function translate(group: keyof typeof translator, raw: unknown): unknown {
  return typeof raw === 'string' ? translator[group][raw] ?? raw : raw
}

/**
 * Resolve an integer index to its actual value from the indexes array.
 *
 * TradingView sends time-based x-coordinates as integer offsets into a
 * separate time array to reduce payload size. This function looks up the
 * actual timestamp or bar index.
 *
 * Example: If indexes = [1672531200, 1672617600, 1672704000],
 *          then indexAt(indexes, 1) → 1672617600
 *
 * Returns the original value if it's not a number.
 */
function indexAt(indexes: unknown[], raw: unknown): unknown {
  return typeof raw === 'number' ? indexes[raw] : raw
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function compactTextItem(item: Record<string, unknown>): string | null {
  const text = textValue(item['text'])
  const toolTip = textValue(item['toolTip'])
  if (!text && !toolTip) {
    return null
  }
  const kind = textValue(item['kind']) ?? 'graphic'
  const id = item['id'] === undefined ? '' : `#${String(item['id'])}`
  const location = [
    item['x'] !== undefined ? `x=${String(item['x'])}` : null,
    item['x1'] !== undefined || item['x2'] !== undefined ? `x=${String(item['x1'])}->${String(item['x2'])}` : null,
    item['y'] !== undefined ? `y=${String(item['y'])}` : null,
    item['y1'] !== undefined || item['y2'] !== undefined ? `y=${String(item['y1'])}->${String(item['y2'])}` : null,
    item['row'] !== undefined && item['column'] !== undefined ? `cell=${String(item['row'])},${String(item['column'])}` : null,
  ].filter(Boolean).join(' ')
  const parts = [`${kind}${id}`, text ? `"${text}"` : null, toolTip && toolTip !== text ? `tip="${toolTip}"` : null, location || null]
  return parts.filter(Boolean).join(' ')
}

function extractTextItems(graphics: {
  labels: Record<string, unknown>[]
  lines: Record<string, unknown>[]
  boxes: Record<string, unknown>[]
  tables: Array<Record<string, unknown> & { cells: Record<string, unknown>[][] }>
}): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []

  for (const label of graphics.labels) {
    if (!textValue(label['text']) && !textValue(label['toolTip'])) continue
    items.push({
      kind: 'label',
      id: label['id'],
      text: label['text'],
      toolTip: label['toolTip'],
      x: label['x'],
      y: label['y'],
      yLoc: label['yLoc'],
      style: label['style'],
      color: label['color'],
      textColor: label['textColor'],
    })
  }

  for (const line of graphics.lines) {
    if (!textValue(line['text']) && !textValue(line['toolTip'])) continue
    items.push({
      kind: 'line',
      id: line['id'],
      text: line['text'],
      toolTip: line['toolTip'],
      x1: line['x1'],
      y1: line['y1'],
      x2: line['x2'],
      y2: line['y2'],
      extend: line['extend'],
      style: line['style'],
      color: line['color'],
    })
  }

  for (const box of graphics.boxes) {
    if (!textValue(box['text']) && !textValue(box['toolTip'])) continue
    items.push({
      kind: 'box',
      id: box['id'],
      text: box['text'],
      toolTip: box['toolTip'],
      x1: box['x1'],
      y1: box['y1'],
      x2: box['x2'],
      y2: box['y2'],
      extend: box['extend'],
      style: box['style'],
      color: box['color'],
      bgColor: box['bgColor'],
      textColor: box['textColor'],
    })
  }

  for (const table of graphics.tables) {
    for (let row = 0; row < table.cells.length; row += 1) {
      const cells = table.cells[row] ?? []
      for (let column = 0; column < cells.length; column += 1) {
        const cell = cells[column]
        if (!cell || (!textValue(cell['text']) && !textValue(cell['toolTip']))) continue
        items.push({
          kind: 'table_cell',
          id: cell['id'],
          tableId: table['id'],
          text: cell['text'],
          toolTip: cell['toolTip'],
          row,
          column,
          position: table['position'],
          textColor: cell['textColor'],
          bgColor: cell['bgColor'],
        })
      }
    }
  }

  return items
}

/**
 * Apply incremental graphic commands to update the store.
 *
 * TradingView sends drawing updates as command batches:
 *
 * **Erase commands** remove drawings:
 * - `{ action: 'all', type: 'dwglabels' }` → remove all labels
 * - `{ action: 'all' }` (no type) → remove all drawings of all types
 * - `{ action: 'one', type: 'dwglabels', id: '123' }` → remove label #123
 *
 * **Create commands** add or update drawings:
 * - `{ create: { dwglabels: [{ data: [{ id: '123', x: 0, y: 100, ... }] }] } }`
 *
 * The store is immutable — this function returns a new store with changes applied.
 *
 * @param store - Current graphic store
 * @param commands - Command batch from TradingView (`graphicsCmds` field)
 * @returns New store with commands applied
 */
export function applyTradingViewGraphicCommands(
  store: TradingViewGraphicStore,
  commands: Record<string, unknown>,
): TradingViewGraphicStore {
  // Shallow-copy the store to avoid mutating the original
  const next: TradingViewGraphicStore = Object.fromEntries(
    Object.entries(store).map(([type, drawings]) => [type, { ...drawings }]),
  )

  // Process erase commands first
  const erase = commands['erase']
  if (Array.isArray(erase)) {
    for (const rawInstruction of erase) {
      if (!rawInstruction || typeof rawInstruction !== 'object') continue
      const instruction = rawInstruction as Record<string, unknown>
      const type = typeof instruction['type'] === 'string' ? instruction['type'] : ''

      // Erase all drawings of a type, or all types if no type specified
      if (instruction['action'] === 'all') {
        if (type) delete next[type]
        else Object.keys(next).forEach((key) => { next[key] = {} })
      }
      // Erase a single drawing by id
      if (instruction['action'] === 'one' && type) {
        delete next[type]?.[String(instruction['id'])]
      }
    }
  }

  // Process create commands (add or update drawings)
  const create = commands['create']
  if (create && typeof create === 'object') {
    for (const [type, groups] of Object.entries(create as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue
      next[type] = { ...(next[type] ?? {}) }
      for (const group of groups) {
        const data = group && typeof group === 'object'
          ? (group as Record<string, unknown>)['data']
          : null
        if (!Array.isArray(data)) continue
        // Each drawing is stored by its unique id
        for (const item of data) {
          if (!item || typeof item !== 'object') continue
          const drawing = item as Record<string, unknown>
          next[type][String(drawing['id'])] = drawing
        }
      }
    }
  }

  return next
}

/**
 * Parse the raw graphic store into a user-friendly format.
 *
 * Transforms abbreviated TradingView wire format into readable objects:
 * - Expands abbreviated property names (ci → color, st → style, etc.)
 * - Translates enum values (r → right, ab → abovebar, etc.)
 * - Resolves time indexes to actual timestamps
 * - Groups related objects (table cells with their parent table)
 *
 * Each drawing type has its own parsing logic to handle its specific structure.
 *
 * @param store - Raw graphic store (output of `applyTradingViewGraphicCommands`)
 * @param indexes - Time index array for resolving x-coordinates
 * @returns Normalized graphic data with readable property names
 */
export function parseTradingViewGraphics(
  store: TradingViewGraphicStore,
  indexes: unknown[] = [],
): TradingViewGraphicData {
  const graphics = {
    // Parse label markers (text annotations on the chart)
    labels: values(store, 'dwglabels').map((label) => ({
      id: label['id'],
      x: indexAt(indexes, label['x']),
      y: label['y'],
      yLoc: translate('yLoc', label['yl']),
      text: label['t'],
      style: translate('labelStyle', label['st']),
      color: label['ci'],
      textColor: label['tci'],
      size: label['sz'],
      textAlign: label['ta'],
      toolTip: label['tt'],
    })),
    // Parse trend lines and arrows
    lines: values(store, 'dwglines').map((line) => ({
      id: line['id'],
      x1: indexAt(indexes, line['x1']),
      y1: line['y1'],
      x2: indexAt(indexes, line['x2']),
      y2: line['y2'],
      extend: translate('extend', line['ex']),
      style: translate('lineStyle', line['st']),
      color: line['ci'],
      width: line['w'],
      text: line['t'],
      toolTip: line['tt'],
    })),
    // Parse rectangular boxes with optional text content
    boxes: values(store, 'dwgboxes').map((box) => ({
      id: box['id'],
      x1: indexAt(indexes, box['x1']),
      y1: box['y1'],
      x2: indexAt(indexes, box['x2']),
      y2: box['y2'],
      color: box['c'],
      bgColor: box['bc'],
      extend: translate('extend', box['ex']),
      style: translate('boxStyle', box['st']),
      width: box['w'],
      text: box['t'],
      textSize: box['ts'],
      textColor: box['tc'],
      textVAlign: box['tva'],
      textHAlign: box['tha'],
      textWrap: box['tw'],
      toolTip: box['tt'],
    })),
    // Parse tables: multi-cell grids with formatting
    // Table cells are stored separately and need to be grouped by parent table id
    tables: values(store, 'dwgtables').map((table) => {
      const cells: Record<string, unknown>[][] = []
      // Find all cells belonging to this table and organize them by row/column
      for (const cell of values(store, 'dwgtablecells')) {
        if (cell['tid'] !== table['id']) continue  // tid = table id
        const row = Number(cell['row'])
        const column = Number(cell['col'])
        if (!Number.isInteger(row) || !Number.isInteger(column)) continue
        cells[row] ??= []
        cells[row][column] = {
          id: cell['id'],
          text: cell['t'],
          toolTip: cell['tt'],
          width: cell['w'],
          height: cell['h'],
          textColor: cell['tc'],
          textHAlign: cell['tha'],
          textVAlign: cell['tva'],
          textSize: cell['ts'],
          bgColor: cell['bgc'],
        }
      }
      return {
        id: table['id'],
        position: table['pos'],
        rows: table['rows'],
        columns: table['cols'],
        bgColor: table['bgc'],
        frameColor: table['frmc'],
        frameWidth: table['frmw'],
        borderColor: table['brdc'],
        borderWidth: table['brdw'],
        cells,
      }
    }),
    // Parse horizontal lines: constant price levels across a time range
    horizLines: values(store, 'horizlines').map((line) => ({
      ...line,
      startIndex: indexAt(indexes, line['startIndex']),
      endIndex: indexAt(indexes, line['endIndex']),
    })),
    // Parse polygons: multi-point shapes (triangles, custom shapes, etc.)
    polygons: values(store, 'polygons').map((polygon) => ({
      ...polygon,
      points: Array.isArray(polygon['points'])
        ? polygon['points'].map((point) => (
          point && typeof point === 'object'
            ? { ...point as Record<string, unknown>, index: indexAt(indexes, (point as Record<string, unknown>)['index']) }
            : point
        ))
        : [],
    })),
    // Parse horizontal histograms: price distribution / volume profile
    horizHists: values(store, 'hhists').map((hist) => ({
      ...hist,
      firstBarTime: indexAt(indexes, hist['firstBarTime']),
      lastBarTime: indexAt(indexes, hist['lastBarTime']),
    })),
    // Keep raw store for debugging or advanced use cases
    raw: store,
  }
  const textItems = extractTextItems(graphics)
  return {
    ...graphics,
    textItems,
    plainText: textItems.map(compactTextItem).filter((item): item is string => typeof item === 'string'),
  }
}
