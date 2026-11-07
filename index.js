import { readFile, stat } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

export const name = 'doc-read'
export const inject = ['tools']

/* ─────────────────────────── 配置 ─────────────────────────── */

const DEFAULTS = {
  pageChars: 1500,   // 单页最多返回字符
  totalChars: 6000,  // 单次 doc_read 的总预算
  hits: 30,          // doc_grep 默认最多命中数
  snippet: 80,       // doc_grep 每条片段长度
  scanPages: 300,    // doc_grep 默认最多扫多少页
}


/* ────────────────────── 最小 ZIP 读取（docx/xlsx） ────────────────────── */

function readZipEntries(buf) {
  // 从尾部找 EOCD (0x06054b50)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx/xlsx')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const fname = buf.toString('utf8', off + 46, off + 46 + nameLen)
    entries.set(fname, { method, csize, localOff })
    off += 46 + nameLen + extraLen + cmtLen
  }
  return {
    has: (n) => entries.has(n),
    read: (n) => {
      const e = entries.get(n)
      if (!e) return null
      const nameLen = buf.readUInt16LE(e.localOff + 26)
      const extraLen = buf.readUInt16LE(e.localOff + 28)
      const start = e.localOff + 30 + nameLen + extraLen
      const raw = buf.subarray(start, start + e.csize)
      return e.method === 0 ? raw : inflateRawSync(raw)
    },
  }
}

function decodeEntities(t) {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
}

function docxText(buf) {
  const zip = readZipEntries(buf)
  const xml = zip.read('word/document.xml')
  if (!xml) throw new Error('docx 里找不到 word/document.xml')
  const out = xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(out).replace(/\n{3,}/g, '\n\n').trim()
}

function xlsxText(buf) {
  const zip = readZipEntries(buf)
  const shared = zip.read('xl/sharedStrings.xml')
  const pool = []
  if (shared) {
    const sx = shared.toString('utf8')
    for (const m of sx.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      pool.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')))
    }
  }
  const lines = []
  const names = [...Array(50).keys()].map((i) => `xl/worksheets/sheet${i + 1}.xml`)
  for (const nm of names) {
    const sh = zip.read(nm)
    if (!sh) continue
    const sx = sh.toString('utf8')
    for (const rm of sx.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1]
        const inner = cm[2]
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)
        const isStr = /t="s"/.test(attrs)
        if (v) cells.push(isStr ? (pool[+v[1]] ?? '') : v[1])
        else if (/t="inlineStr"/.test(attrs)) {
          const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)
          cells.push(t ? decodeEntities(t[1]) : '')
        }
      }
      if (cells.some((c) => c !== '')) lines.push(cells.join('\t'))
    }
  }
  return lines.join('\n')
}

/* ─────────────────────────── PDF ─────────────────────────── */

let pdfjsMod = null
async function pdfjs() {
  if (!pdfjsMod) pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsMod
}

async function openPdf(buf) {
  const m = await pdfjs()
  return m.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise
}

async function pdfPageText(doc, pageNo) {
  const page = await doc.getPage(pageNo)
  const tc = await page.getTextContent()
  let out = ''
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue
    out += it.str + (it.hasEOL ? '\n' : '')
  }
  page.cleanup()
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/* ─────────────────────── 统一入口：按类型取「页」  ─────────────────────── */

async function loadDoc(file) {
  const st = await stat(file).catch(() => null)
  if (!st || !st.isFile()) throw new Error('文件不存在: ' + file)
  const buf = await readFile(file)
  const ext = (file.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase()
  const base = { file, bytes: buf.length, kind: ext || '?' }

  if (ext === 'pdf') {
    const doc = await openPdf(buf)
    const pages = new Array(doc.numPages)
    return {
      ...base,
      kind: 'pdf',
      count: doc.numPages,
      unit: '页',
      page: async (i) => (pages[i] ??= await pdfPageText(doc, i)),
      close: async () => doc.destroy(),
    }
  }

  let text = ''
  if (ext === 'docx') { text = docxText(buf); base.kind = 'docx' }
  else if (ext === 'xlsx') { text = xlsxText(buf); base.kind = 'xlsx' }
  else {
    let dec
    try { dec = new TextDecoder('utf-8', { fatal: true }) } catch { dec = new TextDecoder('utf-8') }
    try { text = dec.decode(buf) } catch { text = new TextDecoder('gb18030').decode(buf) }
    base.kind = ext || 'text'
  }
  // 非 PDF 按「每 60 行算一页」，与阅读习惯对齐
  const LINES_PER_PAGE = 60
  const lines = text.split('\n')
  const pages = []
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE).join('\n'))
  return {
    ...base,
    kind: base.kind,
    count: Math.max(pages.length, 1),
    unit: '块(60行)',
    page: async (i) => pages[i - 1] ?? '',
    close: async () => {},
  }
}

/* ─────────────────────────── 三个操作 ─────────────────────────── */

async function outline(args, cfg) {
  const d = await loadDoc(args.path)
  try {
    const cap = Math.min(args.maxPages ?? 60, d.count)
    // 先把采样页的前几行取出来，统计重复行——PDF 常见页眉/页脚每页重复，
    // 直接取首行会让目录全是「第 N 页」这类噪声。
    const raw = []
    let chars = 0
    for (let i = 1; i <= cap; i++) {
      const t = await d.page(i)
      chars += t.length
      const lines = t.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).slice(0, 4)
      raw.push({ p: i, c: t.length, lines })
    }
    const freq = new Map()
    const norm = (l) => l.replace(/[0-9０-９]+/g, "#").replace(/s+/g, " ")
    for (const r of raw) for (const l of new Set(r.lines.map(norm))) freq.set(l, (freq.get(l) || 0) + 1)
    const REPEAT_MIN = Math.max(3, Math.ceil(cap * 0.4))
    const noise = (l) => (freq.get(norm(l)) || 0) >= REPEAT_MIN
      || /^[-—s]*d{1,4}[-—s]*$/.test(l) || /^第s*d+s*页/.test(l)
    const items = raw.map((r) => ({
      p: r.p, c: r.c,
      head: ((r.lines.find((l) => !noise(l)) || r.lines[0] || "")).slice(0, 60),
    }))
    return {
      file: d.file, kind: d.kind, size: d.bytes,
      pages: d.count, unit: d.unit,
      charsOfFirst: chars, sampled: cap < d.count ? `${cap}/${d.count}` : 'all',
      outline: items,
      hint: cap < d.count
        ? `只摘要了前 ${cap} 页；用 doc_grep 定位后再 doc_read 读具体页，比整本读完省 token。`
        : '整本已摘要；下一步用 doc_read 读需要的页，或用 doc_grep 直接找关键词。',
    }
  } finally { await d.close() }
}

async function read(args, cfg) {
  const d = await loadDoc(args.path)
  try {
    const from = Math.max(1, args.from ?? 1)
    const to = Math.min(d.count, args.to ?? args.from ?? from)
    const pageCap = args.pageChars ?? cfg.pageChars
    const budget = args.maxChars ?? cfg.totalChars
    const pages = []
    let used = 0, stopped = null
    for (let i = from; i <= to; i++) {
      const t = await d.page(i)
      const room = budget - used
      if (room <= 80) { stopped = i; break }
      const cut = t.length > Math.min(pageCap, room)
      const body = t.slice(0, Math.min(pageCap, room))
      pages.push(cut ? { p: i, c: t.length, text: body, cut: true } : { p: i, c: t.length, text: body })
      used += body.length
    }
    const lastDone = pages.length ? pages[pages.length - 1].p : from - 1
    return {
      file: d.file, kind: d.kind, pages: d.count, unit: d.unit,
      range: `${from}-${to}`, returned: `${pages.length}`,
      chars: used,
      body: pages,
      next: stopped ? { from: stopped, to, why: '本次字符预算用尽' } : null,
      hint: stopped
        ? `预算用完，第 ${stopped} 页没读。继续就 doc_read(from=${stopped})，或缩小 to 只读关键页。`
        : (lastDone < to ? `已读到第 ${lastDone} 页。` : '区间已读完。'),
    }
  } finally { await d.close() }
}

async function grep(args, cfg) {
  const d = await loadDoc(args.path)
  try {
    const limit = args.limit ?? cfg.hits
    const snip = args.snippet ?? cfg.snippet
    const maxScan = Math.min(args.scanPages ?? cfg.scanPages, d.count)
    const raw = String(args.pattern ?? '')
    if (!raw) throw new Error('pattern 不能为空')
    let re
    try {
      re = args.regex ? new RegExp(raw, args.ignoreCase === false ? 'g' : 'gi')
        : new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.ignoreCase === false ? 'g' : 'gi')
    } catch (e) { throw new Error('正则无效: ' + e.message) }

    const hits = []
    let scanned = 0, total = 0
    for (let i = 1; i <= maxScan && hits.length < limit; i++) {
      const t = await d.page(i)
      scanned++
      if (!t) continue
      for (const line of t.split('\n')) {
        if (!line.trim()) continue
        re.lastIndex = 0
        if (!re.test(line)) continue
        total++
        if (hits.length < limit) hits.push({ p: i, t: line.trim().slice(0, snip * 2) })
      }
    }
    return {
      file: d.file, kind: d.kind, pages: d.count,
      pattern: raw, regex: !!args.regex,
      scanned: `${scanned}/${d.count}`,
      hits, hitCount: hits.length, matchedLines: total,
      truncated: total > hits.length || scanned < d.count ? true : false,
      hint: hits.length
        ? `命中集中在第 ${[...new Set(hits.map((h) => h.p))].slice(0, 12).join(',')} 页；用 doc_read 读这些页拿上下文。`
        : `前 ${scanned} 页没命中；可换关键词，或先 doc_outline 看结构。`,
    }
  } finally { await d.close() }
}

/* ─────────────────────────── 注册 ─────────────────────────── */

const common = {
  path: { type: 'string', description: 'Absolute path to the document (.pdf / .docx / .xlsx / .txt / .md / .csv).' },
}

const fmt = {
  schema: { type: 'object' },
  render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  ctx.effect(() => ctx.tools.register({
    name: 'doc_outline',
    description: 'List a document\'s pages with a one-line preview of each, plus page count and byte size. '
      + 'Cheapest way to see a document\'s shape before reading it — use this first instead of reading the whole file.',
    parameters: {
      type: 'object',
      properties: {
        ...common,
        maxPages: { type: 'number', description: 'How many pages to preview (default 60).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: fmt,
    execute: (a) => outline(a, cfg),
    isConcurrencySafe: () => true,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'doc_read',
    description: 'Read a page range of a document as plain text, with page markers. '
      + 'Per-page and total character caps keep the output small; the result tells you which page to read next. '
      + 'Prefer doc_grep when you only need one fact out of a long document.',
    parameters: {
      type: 'object',
      properties: {
        ...common,
        from: { type: 'number', description: 'First page (1-based, default 1).' },
        to: { type: 'number', description: 'Last page inclusive (default = from).' },
        maxChars: { type: 'number', description: 'Total character budget for this call (default 6000).' },
        pageChars: { type: 'number', description: 'Per-page character cap (default 1500).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: fmt,
    execute: (a) => read(a, cfg),
    isConcurrencySafe: () => true,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'doc_grep',
    description: 'Find a keyword or regex inside a document and return only the matching lines with page numbers. '
      + 'This is the token-cheapest way to pull one fact out of a long PDF/Word file.',
    parameters: {
      type: 'object',
      properties: {
        ...common,
        pattern: { type: 'string', description: 'Keyword, or a regex when regex=true.' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false).' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive (default true).' },
        limit: { type: 'number', description: 'Max hits to return (default 30).' },
        snippet: { type: 'number', description: 'Max characters per hit line (default 80).' },
        scanPages: { type: 'number', description: 'Max pages to scan (default 300).' },
      },
      required: ['path', 'pattern'],
      additionalProperties: false,
    },
    output: fmt,
    execute: (a) => grep(a, cfg),
    isConcurrencySafe: () => true,
  }))
}
