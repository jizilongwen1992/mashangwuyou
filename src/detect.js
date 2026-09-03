/**
 * 自动识别：在 PDF 的文字层里查你设置的姓名、单位、简称、身份证号，直接给出坐标。
 *
 * 这是网页版和小程序版最大的差别。小程序自己渲染不了 PDF，也拿不到文字层，
 * 只能把文件传到服务器去识别；浏览器能直接读 PDF 的文字层，
 * 所以这一步在本机就能做完，不联网，也不需要 OCR。
 *
 * 边界要说清楚：
 *   有文字层的 PDF（Word 导出的承诺书、论文、业绩表）—— 能查，准，位置就是字的真实位置。
 *   扫描件与图片 —— 整页是像素，没有文字可查，只能自己拖框。
 * 照片、公章、签名这三类无论哪种材料都得手动框，机器认不出来。
 */

import { needles } from './store.js?v=20260903155602'
import { makeRect } from './textpick.js?v=20260903155602'

export const LABELS = { name: '姓名', org: '单位', idNo: '身份证号', photo: '照片', seal: '公章', sign: '签名' }

/** 身份证号：18 位带校验位，15 位是老号。不依赖你有没有填，见到就报。 */
const ID18 = /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g
const ID15 = /[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g

/** 字符框紧贴字形，涂色要略微外扩才不露笔画的顶边和右边。单位是点。 */
const PAD_RATIO = 0.08
const PAD_MIN = 0.8

/**
 * 把一行文字压掉空白，并留下「压缩后位置 -> 原始字序号」的映射。
 * 为什么要压：PDF 里的身份证号常被切成「3401 0119 8001 011234」，
 * 带着空格去比对永远对不上；压掉空白就能一次命中。
 */
function squeeze(text) {
  let s = ''
  const map = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!ch.trim()) continue
    s += ch
    map.push(i)
  }
  return { s, map }
}

function rectFromChars(chars, from, to, kind, label) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = from; i <= to; i++) {
    const b = chars[i]
    if (!b) continue
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1])
    x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3])
  }
  if (x0 === Infinity) return null
  const pad = Math.max(PAD_MIN, (y1 - y0) * PAD_RATIO)
  return makeRect({
    x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2,
    kind, label, source: 'auto', accepted: true, confidence: 0.98
  })
}

/**
 * @param lines 该页的文字行 [{t, c:[[x,y,w,h],...]}]，坐标为页点
 * @param profile 要打码的信息
 * @returns 候选框，坐标同为页点
 */
export function detectLines(lines, profile) {
  const list = needles(profile)
  const out = []

  ;(lines || []).forEach(ln => {
    const { s, map } = squeeze(ln.t || '')
    if (!s) return
    const used = new Array(s.length).fill(false)

    const take = (from, to, kind, label) => {
      for (let i = from; i <= to; i++) if (used[i]) return      // 已被更长的词占了
      for (let i = from; i <= to; i++) used[i] = true
      const r = rectFromChars(ln.c, map[from], map[to], kind, label)
      if (r) out.push(r)
    }

    // 先按你设置的词匹配。长词在前，短简称不会先把长单位名切开。
    list.forEach(n => {
      const needle = n.text.replace(/\s+/g, '')
      if (!needle) return
      let at = s.indexOf(needle)
      while (at >= 0) {
        take(at, at + needle.length - 1, n.kind, LABELS[n.kind] || '敏感信息')
        at = s.indexOf(needle, at + 1)
      }
    })

    // 再按身份证号的形状兜一遍：你没填、或者填的和材料里写法不同，也能查出来。
    ;[ID18, ID15].forEach(re => {
      re.lastIndex = 0
      let m
      while ((m = re.exec(s)) !== null) {
        take(m.index, m.index + m[0].length - 1, 'idNo', LABELS.idNo)
      }
    })
  })

  return dedupe(out)
}

/** 去掉被别的框整个包住的框：单位名里含姓名时，两个框会叠在一起 */
function dedupe(rects) {
  return rects.filter((a, i) => !rects.some((b, j) => {
    if (i === j) return false
    const inside = a.x >= b.x - 0.5 && a.y >= b.y - 0.5 &&
                   a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5
    const bBigger = b.w * b.h > a.w * a.h
    return inside && bBigger
  }))
}

/** 出件自检用：这段文字里还留着哪些该盖的内容 */
export function findLeaks(text, profile) {
  const flat = (text || '').replace(/\s+/g, '')
  if (!flat) return []
  const hits = []
  needles(profile).forEach(n => {
    const needle = n.text.replace(/\s+/g, '')
    if (needle && flat.indexOf(needle) >= 0 && !hits.some(h => h.text === needle)) {
      hits.push({ text: needle, kind: n.kind, label: LABELS[n.kind] || '敏感信息' })
    }
  })
  ;[ID18, ID15].forEach(re => {
    re.lastIndex = 0
    let m
    while ((m = re.exec(flat)) !== null) {
      if (!hits.some(h => h.text === m[0])) hits.push({ text: m[0], kind: 'idNo', label: LABELS.idNo })
    }
  })
  return hits
}
