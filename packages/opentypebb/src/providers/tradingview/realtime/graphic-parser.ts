type Translator = Record<string, Record<string, string>>

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

export type TradingViewGraphicStore = Record<string, Record<string, Record<string, unknown>>>

export interface TradingViewGraphicData {
  labels: Record<string, unknown>[]
  lines: Record<string, unknown>[]
  boxes: Record<string, unknown>[]
  tables: Array<Record<string, unknown> & { cells: Record<string, unknown>[][] }>
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
    horizLines: [],
    polygons: [],
    horizHists: [],
    raw: {},
  }
}

function values(source: TradingViewGraphicStore, type: string): Record<string, unknown>[] {
  return Object.values(source[type] ?? {})
}

function translate(group: keyof typeof translator, raw: unknown): unknown {
  return typeof raw === 'string' ? translator[group][raw] ?? raw : raw
}

function indexAt(indexes: unknown[], raw: unknown): unknown {
  return typeof raw === 'number' ? indexes[raw] : raw
}

export function applyTradingViewGraphicCommands(
  store: TradingViewGraphicStore,
  commands: Record<string, unknown>,
): TradingViewGraphicStore {
  const next: TradingViewGraphicStore = Object.fromEntries(
    Object.entries(store).map(([type, drawings]) => [type, { ...drawings }]),
  )

  const erase = commands['erase']
  if (Array.isArray(erase)) {
    for (const rawInstruction of erase) {
      if (!rawInstruction || typeof rawInstruction !== 'object') continue
      const instruction = rawInstruction as Record<string, unknown>
      const type = typeof instruction['type'] === 'string' ? instruction['type'] : ''

      if (instruction['action'] === 'all') {
        if (type) delete next[type]
        else Object.keys(next).forEach((key) => { next[key] = {} })
      }
      if (instruction['action'] === 'one' && type) {
        delete next[type]?.[String(instruction['id'])]
      }
    }
  }

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

export function parseTradingViewGraphics(
  store: TradingViewGraphicStore,
  indexes: unknown[] = [],
): TradingViewGraphicData {
  return {
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
    })),
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
    })),
    tables: values(store, 'dwgtables').map((table) => {
      const cells: Record<string, unknown>[][] = []
      for (const cell of values(store, 'dwgtablecells')) {
        if (cell['tid'] !== table['id']) continue
        const row = Number(cell['row'])
        const column = Number(cell['col'])
        if (!Number.isInteger(row) || !Number.isInteger(column)) continue
        cells[row] ??= []
        cells[row][column] = {
          id: cell['id'],
          text: cell['t'],
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
    horizLines: values(store, 'horizlines').map((line) => ({
      ...line,
      startIndex: indexAt(indexes, line['startIndex']),
      endIndex: indexAt(indexes, line['endIndex']),
    })),
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
    horizHists: values(store, 'hhists').map((hist) => ({
      ...hist,
      firstBarTime: indexAt(indexes, hist['firstBarTime']),
      lastBarTime: indexAt(indexes, hist['lastBarTime']),
    })),
    raw: store,
  }
}
