/**
 * 点字选：鼠标（或手指）从字上划过，划到的字合成遮盖框。
 *
 * 为什么要到字符级：按词切分对中文没用——中文没有空格，一整句会被当成一个词，
 * 选中粒度太粗，盖不出「王某某」这三个字。字符级才够准。
 *
 * 输入的 lines 与输出的框，坐标都是该页的单位空间（PDF 页点），与拖框选完全一致。
 * 逻辑与小程序版 utils/textpick.js 同一份，只是改成了 ES 模块。
 */

const HIT_SLOP = 1.5       // 命中判定放宽一点点（单位：点），鼠标没那么准
const PAD_RATIO = 0.06     // 字符框紧贴字形，涂色略微外扩才不露笔画
const PAD_MIN = 0.6

/** 预处理：给每行算出 y 范围，划动时先按行筛，避免每次遍历全页字符 */
export function index(lines) {
  return (lines || []).map((ln, li) => {
    let top = Infinity, bottom = -Infinity
    ln.c.forEach(b => {
      top = Math.min(top, b[1])
      bottom = Math.max(bottom, b[1] + b[3])
    })
    return { li, text: ln.t, chars: ln.c, top, bottom }
  })
}

/**
 * 点落在哪个字上，返回 "行:字" 的键；没落在字上返回 null。
 *
 * 两遍：先严格看点在不在某个字的盒子里，没有再放宽 HIT_SLOP 找一遍。
 * 不能一上来就放宽——相邻两个字紧挨着，放宽后它们的判定范围重叠，
 * 落在交界处的点永远算给左边那个字，往右划就卡在原地不动了。
 */
export function hit(indexed, x, y) {
  return scan(indexed, x, y, 0) || scan(indexed, x, y, HIT_SLOP)
}

function scan(indexed, x, y, slop) {
  for (let i = 0; i < indexed.length; i++) {
    const ln = indexed[i]
    if (y < ln.top - slop || y > ln.bottom + slop) continue
    for (let j = 0; j < ln.chars.length; j++) {
      const b = ln.chars[j]
      if (x >= b[0] - slop && x <= b[0] + b[2] + slop &&
          y >= b[1] - slop && y <= b[1] + b[3] + slop) {
        return ln.li + ':' + j
      }
    }
  }
  return null
}

/** 把选中的键集合转成高亮用的字符框 */
export function highlights(indexed, keys) {
  const out = []
  keys.forEach(k => {
    const [li, ci] = k.split(':').map(Number)
    const ln = indexed.find(l => l.li === li)
    if (!ln) return
    const b = ln.chars[ci]
    if (b) out.push({ x: b[0], y: b[1], w: b[2], h: b[3] })
  })
  return out
}

/**
 * 按行分组、行内按连续字符分段，每段合成一个框。
 * 划过的字通常连续，分段是为了处理中间跳过几个字的情况。
 */
export function toRects(indexed, keys, tag) {
  const byLine = {}
  Array.from(new Set(keys)).forEach(k => {
    const [li, ci] = k.split(':').map(Number)
    if (!byLine[li]) byLine[li] = []
    byLine[li].push(ci)
  })

  const rects = []
  Object.keys(byLine).forEach(li => {
    const ln = indexed.find(l => l.li === Number(li))
    if (!ln) return
    const cis = byLine[li].sort((a, b) => a - b)
    let seg = [cis[0]]
    const flush = () => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const text = []
      seg.forEach(ci => {
        const b = ln.chars[ci]
        if (!b) return
        x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1])
        x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3])
        text.push(ln.text[ci] || '')
      })
      if (x0 === Infinity) return
      const pad = Math.max(PAD_MIN, (y1 - y0) * PAD_RATIO)
      rects.push(makeRect({
        x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2,
        kind: 'picked',
        label: (tag || '') + (text.join('').trim().slice(0, 8) || '选中'),
        source: 'picked'
      }))
    }
    for (let i = 1; i < cis.length; i++) {
      if (cis[i] === cis[i - 1] + 1) seg.push(cis[i])
      else { flush(); seg = [cis[i]] }
    }
    flush()
  })
  return rects
}

let rectSeq = 0

export function makeRect(r) {
  return {
    id: 'r' + Date.now().toString(36) + '_' + (++rectSeq),
    x: Math.max(0, r.x), y: Math.max(0, r.y), w: r.w, h: r.h,
    kind: r.kind || 'manual',
    label: r.label || '手动',
    confidence: typeof r.confidence === 'number' ? r.confidence : 1,
    accepted: r.accepted !== false,
    style: r.style || 'solid',
    source: r.source || 'manual'
  }
}
