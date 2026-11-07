// 自测：直接调三个工具的实现，跑仓库内自带的样例文件（test/fixtures/）。
// 三种格式各跑一遍 outline / read / grep，并对结果做断言；
// 任何一项断言失败，退出码非 0。
//
// 想用你自己的大文件压测，设环境变量 DOC_READ_SAMPLES 指向一个目录，
// 里面放任意 .pdf/.docx/.xlsx/.txt，自测会跑那批文件而不是 fixtures。
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(new URL('./index.js', import.meta.url).href)

const tools = {}
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  tools: { register: (t) => { tools[t.name] = t; return () => {} } },
}
mod.apply(ctx, {})

const call = async (name, args) => {
  const t0 = Date.now()
  const v = await tools[name].execute(args)
  const txt = JSON.stringify(v)
  return { ms: Date.now() - t0, chars: txt.length, value: v }
}

// 样例清单：默认用仓库内 fixtures
const sampleDir = process.env.DOC_READ_SAMPLES || path.join(here, 'test', 'fixtures')
if (!fs.existsSync(sampleDir)) {
  console.error(`样例目录不存在：${sampleDir}`)
  process.exit(1)
}
const files = fs.readdirSync(sampleDir)
  .filter((f) => /\.(pdf|docx|xlsx|txt|md|csv)$/i.test(f))
  .sort()
if (!files.length) {
  console.error(`样例目录里没有可读文件：${sampleDir}`)
  process.exit(1)
}

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
}

console.log(`样例目录：${sampleDir}（${files.length} 个文件）`)

for (const f of files) {
  const p = path.join(sampleDir, f)
  console.log(`\n【${f}】`)
  try {
    const o = await call('doc_outline', { path: p, maxPages: 8 })
    console.log(`  outline: ${o.ms}ms  ${o.chars} 字符 | ${o.value.kind} ${o.value.pages}${o.value.unit || ''} ${o.value.size} B`)
    check('outline 有页数', Number(o.value.pages) > 0, `pages=${o.value.pages}`)
    check('outline 有预览行', Array.isArray(o.value.outline) && o.value.outline.length > 0)

    const r = await call('doc_read', { path: p, from: 1, to: 2, maxChars: 1500 })
    console.log(`  read p1-2: ${r.ms}ms  ${r.chars} 字符 | 返回 ${r.value.returned} 页, 用了 ${r.value.chars} 字`)
    check('read 返回了页', Number(r.value.returned) > 0, `returned=${r.value.returned}`)
    const body = Array.isArray(r.value.body) ? r.value.body.map((x) => x.text || '').join('') : ''
    check('read 有正文', body.length > 0, 'body=' + body.length + ' 字')

    const g = await call('doc_grep', { path: p, pattern: 'fixture', limit: 5, scanPages: 40 })
    console.log(`  grep:      ${g.ms}ms  ${g.chars} 字符 | 命中 ${g.value.hitCount} 行, 扫了 ${g.value.scanned} 页`)
    check('grep 命中 fixture', Number(g.value.hitCount) > 0, `hitCount=${g.value.hitCount}`)
  } catch (e) {
    failures++
    console.log(`  FAIL 抛异常：${e.message}`)
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exitCode = failures === 0 ? 0 : 1
