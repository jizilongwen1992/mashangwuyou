/**
 * PDF 对接层，包住 pdf.js。
 *
 * 页坐标一律用「页点」（1/72 英寸，getViewport({scale:1}) 的尺寸，已把页面自带的旋转算进去）。
 * 框存点坐标，屏幕上显示乘一个倍数，出件时再乘另一个倍数，两头都不会偏。
 */

import * as pdfjsLib from '../vendor/pdf.min.mjs'

// worker、CMap、标准字体都用工程里的 vendor/，不请求外部地址。
// CMap 是中文 PDF 的字符映射表，缺了它某些用预定义 CMap 的 PDF 取不到文字。
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href
const CMAP_URL = new URL('../vendor/cmaps/', import.meta.url).href
const FONT_URL = new URL('../vendor/standard_fonts/', import.meta.url).href

export const MAX_PAGES = 100
export const MIN_TEXT_CHARS = 20      // 少于这么多字就当没有文字层，只能拖框

/** 中日韩与全角字符：切分字符宽度时算整格，其余算半格 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F]/

export async function open(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let doc
  try {
    // slice() 给 pdf.js —— 它会把传进去的 buffer 交给 worker，原来那份就空了，
    // 而出件时 pdf-lib 还要用原始字节，所以留一份完整的。
    doc = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      isEvalSupported: false
    }).promise
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('这个 PDF 有密码，请先去掉密码再打开')
    throw new Error('这个 PDF 打不开：' + ((e && e.message) || '格式不认识'))
  }
  if (!doc.numPages) throw new Error('这个 PDF 没有页面')
  if (doc.numPages > MAX_PAGES) {
    throw new Error('这个 PDF 有 ' + doc.numPages + ' 页，超过 ' + MAX_PAGES + ' 页上限，请先拆分')
  }

  // 只量尺寸，不在这里读文字层——一本厚的要读好几秒，
  // 而「这页有没有文字」等翻到那页再算就行。
  const pages = []
  for (let i = 0; i < doc.numPages; i++) {
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 })
    pages.push({ index: i, w: vp.width, h: vp.height, hasText: null })
  }
  return { doc, bytes, pages }
}

/**
 * 把某一页画到画布上。scale 是「点 -> 画布像素」的倍数。
 *
 * intent 用 'print' 而不是默认的 'display'，两个原因：
 *
 * 一、pdf.js 在 display 模式下用 requestAnimationFrame 分片渲染，
 *     浏览器标签页切到后台时 rAF 不再触发，渲染就永远停在那儿。
 *     出一份几十页的 PDF 要一会儿，用户很可能中途切走去干别的，
 *     回来发现进度条卡死。print 模式不走 rAF，切到后台照样跑完。
 *
 * 二、更要紧的是这个：审阅时看到的和出件时盖进去的必须是同一幅画面。
 *     两条路都用 print，你在屏幕上看到什么，交出去的就是什么。
 *     顺带还稳一点——带 NoView 标记的注释在屏幕上藏着、打印时却会冒出来，
 *     用 print 渲染的话它在审阅时就现形了，你能把它盖掉。
 */
export async function renderPage(doc, index, scale, canvas) {
  const page = await doc.getPage(index + 1)
  const vp = page.getViewport({ scale })
  canvas.width = Math.round(vp.width)
  canvas.height = Math.round(vp.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise
  return { width: canvas.width, height: canvas.height, scale }
}

/**
 * 把一段文字的宽度分给每个字。
 *
 * pdf.js 只给「一整段文字」的总宽，不给逐字宽度，可点字选和自动识别都要落到单个字上，
 * 所以得自己切。切法有讲究：
 *
 * 曾经按 Unicode 类别猜——中文算一格、其余算半格。这是错的，而且错得危险：
 * 有些中文字体（PyMuPDF 用的 Droid Sans Fallback 就是）把阿拉伯数字也排成全角，
 * 「身份证号：340101…」这一行按半角去算，整串数字的起点会右移三十多个点，
 * 前面三位数字露在遮盖框外面。身份证号露三位不是小事。
 *
 * 现在改成量真字体：pdf.js 把 PDF 里的字体注册进了 document.fonts，
 * 用 canvas 的 measureText 一个字一个字量，再按整段的真实总宽归一化。
 * 归一化这步很关键——它把量出来的误差整体抹平，只要相对宽度对，绝对位置就对。
 * 字体没能加载时才退回猜的那套，并且退回时不再假设数字是半角。
 */
function splitChars(widths, ctx, family, str, x0, totalW, top, h, fh) {
  const list = Array.from(str)
  const size = Math.max(4, Math.round(fh))
  if (ctx) ctx.font = size + 'px ' + family
  const ws = list.map(ch => {
    const declared = widths && widths.get(ch)          // 第一手：PDF 自己声明的字宽
    if (typeof declared === 'number' && declared > 0) return declared
    if (ctx) {                                          // 第二手：量浏览器里的字体
      const w = ctx.measureText(ch).width
      if (w > 0) return w / size
    }
    return WIDE.test(ch) ? 1 : 0.55                     // 最后才是猜
  })
  const sum = ws.reduce((a, b) => a + b, 0) || 1
  const k = totalW / sum
  const out = []
  let cx = x0
  list.forEach((ch, i) => {
    const cw = ws[i] * k
    out.push({ c: ch, box: [cx, top, cw, h] })
    cx += cw
  })
  return out
}

/** 量字宽用的画布，全模块共用一个 */
let ruler = null
function measurer() {
  if (ruler === null) {
    try {
      ruler = document.createElement('canvas').getContext('2d')
    } catch (e) {
      ruler = false
    }
  }
  return ruler || null
}

const FALLBACK_FAMILY = '"PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif'

/**
 * 从内容流里取出每个字的真实宽度，顺带把字体加载进浏览器。
 *
 * 为什么非得走这一趟：PDF 里的字宽是文档自己声明的，跟系统装没装那个字体无关。
 * 有些 PDF 不嵌字体（只写「用宋体」），pdf.js 只好拿系统字凑着画，
 * 但排版位置仍按文档声明的宽度走——这时候拿浏览器的字体去量，量到的是另一套数。
 * 实测就栽在这儿：某些中文字体把阿拉伯数字也排成全角，浏览器却按半角量，
 * 一行「身份证号：340101…」算下来数字整体右移三十多个点，前三位露在框外。
 *
 * getOperatorList 给的 glyph.width 是文档声明的那个数（单位 1/1000 字号），
 * 这是唯一可靠的一手数据。它同时会把字体从 worker 送过来并注册进 document.fonts，
 * 所以量字体的退路也是这一趟顺手铺好的。
 *
 * 扫描页不走这里——上层先看有没有文字，没有就直接返回了，
 * 免得为了一张整页大图去解析内容流。
 *
 * @returns Map(字体名 -> Map(字 -> 字宽，单位为字号的倍数))
 */
async function pageMetrics(page) {
  const table = new Map()
  try {
    const ol = await page.getOperatorList()
    let font = null
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i]
      if (fn === pdfjsLib.OPS.setFont) {
        font = ol.argsArray[i][0]
        if (!table.has(font)) table.set(font, new Map())
        continue
      }
      if (fn !== pdfjsLib.OPS.showText && fn !== pdfjsLib.OPS.showSpacedText) continue
      const m = table.get(font)
      if (!m) continue
      const glyphs = ol.argsArray[i][0] || []
      glyphs.forEach(g => {
        // 数字是位置微调量，不是字；宽度为 0 的也不要，那会把整行挤成一条线
        if (!g || typeof g !== 'object') return
        if (typeof g.unicode === 'string' && g.unicode.length === 1 && g.width > 0) {
          m.set(g.unicode, g.width / 1000)
        }
      })
    }
    if (document.fonts && document.fonts.ready) await document.fonts.ready
  } catch (e) { /* 取不到就退回量字体，再不行就猜 */ }
  return table
}

function familyOf(page, fontName) {
  try {
    if (fontName && page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName)
      if (f && f.loadedName) return '"' + f.loadedName + '", ' + FALLBACK_FAMILY
    }
  } catch (e) { /* 拿不到就用兜底字体 */ }
  return FALLBACK_FAMILY
}

/**
 * 取某一页的逐字坐标，供点字选和自动识别用。
 * 返回 [{t: 该行文字, c: [[x, y, w, h], ...]}]，坐标为页点，c[i] 对应 t[i]。
 * 扫描件没有文字层，返回 []。
 */
export async function textLines(doc, index) {
  const page = await doc.getPage(index + 1)
  const vp = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const chars = content.items.reduce((n, it) => n + ((it.str || '').trim().length), 0)
  if (chars < MIN_TEXT_CHARS) return []      // 扫描页，没有文字可切

  const metrics = await pageMetrics(page)
  const ctx = measurer()
  const items = []

  content.items.forEach(it => {
    if (!it.str) return
    // 把文字矩阵与视口矩阵相乘，得到视口（左上原点、y 向下）里的位置
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform)
    const fh = Math.hypot(tx[2], tx[3])
    if (!fh) return
    // 竖排或旋转的文字，用横向矩形去套会歪，跳过它们——那种页只能拖框
    if (Math.abs(tx[1]) > 0.01 * Math.abs(tx[0] || 1) && Math.abs(tx[1]) > 0.2) return
    const width = (it.width || 0) * vp.scale
    if (width <= 0) return
    // 字盒的高度：中文字形大致从基线往上一个字号、往下两成。
    // 这里上下各再放一点点，宁可多盖一丝也不能露出笔画的边。
    const top = tx[5] - fh * 1.02
    items.push({
      baseline: tx[5],
      x: tx[4],
      chars: splitChars(metrics.get(it.fontName), ctx, familyOf(page, it.fontName),
                        it.str, tx[4], width, top, fh * 1.3, fh)
    })
  })

  // 按基线聚成行：同一行的字基线相同，容差取 1.5 点
  items.sort((a, b) => (a.baseline - b.baseline) || (a.x - b.x))
  const rows = []
  items.forEach(it => {
    const row = rows[rows.length - 1]
    if (row && Math.abs(row.baseline - it.baseline) <= 1.5) {
      row.items.push(it)
    } else {
      rows.push({ baseline: it.baseline, items: [it] })
    }
  })

  return rows.map(row => {
    row.items.sort((a, b) => a.x - b.x)
    const t = []
    const c = []
    row.items.forEach(it => it.chars.forEach(ch => { t.push(ch.c); c.push(ch.box) }))
    return { t: t.join(''), c }
  }).filter(ln => ln.t.trim())
}

/** 出件自检用：把一份 PDF 里还能提取到的文字全取出来，按页给 */
export async function extractText(bytes) {
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(), cMapUrl: CMAP_URL, cMapPacked: true,
    standardFontDataUrl: FONT_URL, isEvalSupported: false
  }).promise
  const pages = []
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1)
    const content = await page.getTextContent()
    pages.push(content.items.map(it => it.str || '').join(''))
  }
  doc.destroy()
  return pages
}
