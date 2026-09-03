/**
 * 审阅页：确认机器找出来的框，自己补该盖的地方。整个工具的核心就是这一页。
 *
 * 坐标只有两套，别混：
 *   单位坐标 —— 框存的坐标。图片是自然像素，PDF 页是点。与缩放无关。
 *   屏幕坐标 —— 单位坐标 × dispScale。鼠标事件先减去舞台位置再除以 dispScale 就回到单位坐标。
 */

import { $, $$, esc, toast, confirmBox, alertBox } from './kit.js?v=20260903162636'
import * as job from '../job.js?v=20260903162636'
import * as store from '../store.js?v=20260903162636'
import * as pdfdoc from '../pdfdoc.js?v=20260903162636'
import * as textpick from '../textpick.js?v=20260903162636'
import { detectLines } from '../detect.js?v=20260903162636'
import { loadBitmap } from '../redact.js?v=20260903162636'
import { go } from '../main.js?v=20260903162636'

const HANDLE = 12          // 右下角把手的命中半径（屏幕像素）
const TAP_SLOP = 4         // 移动不到这么多像素就算点一下
const MIN_DRAW = 6         // 画得比这还小就当误操作
const HISTORY_MAX = 30

let f = null               // 当前文件
let pi = 0                 // 当前页序号
let unit = { w: 0, h: 0 }  // 当前页的单位尺寸
let dispScale = 1
let zoom = 1
let mode = 'edit'
let sel = null             // 选中的框 id
let history = []
let lines = null           // 当前页的文字行；null 表示还没取
let indexed = []
let draft = null           // 正在拖的新框（屏幕坐标）
let picks = []             // 点字选的高亮（单位坐标）
let gesture = null
let picked = null
let fillOpen = false       // 遮盖颜色是否展开。收起时只露当前那一块色，不占地方
let mounted = false        // 离开本页后，还在跑的渲染不该再碰 DOM
let renderToken = 0        // 翻页时丢弃过期的渲染结果
let fileToken = 0          // 切文件时中止上一份文件的后台通读

const linesCache = new Map()

export function render(root, args) {
  const j = job.current()
  if (!j) { go('/'); return }
  f = job.file(args[0]) || j.files[0]
  if (!f) { go('/'); return }
  pi = 0
  fileToken++
  zoom = 1
  mode = 'edit'
  sel = null
  history = []

  root.innerHTML = shell()
  mounted = true
  bindStage()
  const offKeys = bindKeys()
  const onResize = () => layout()
  window.addEventListener('resize', onResize)

  paintRail()
  // 不 await：渲染和通读都要花时间，清理函数得先交出去，
  // 否则人在渲染中途点了导航，本页的按键监听就摘不掉。
  loadPage(0).then(prescan)

  return () => {
    mounted = false
    fileToken++             // 让后台通读自己停下
    offKeys()
    window.removeEventListener('resize', onResize)
    linesCache.clear()
  }
}

/* ---------------- 骨架 ---------------- */

function shell() {
  return `
  <section class="review">
    <div class="rv-head">
      <div class="rv-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="rv-count" id="rv-count"></div>
      <div class="rv-head-right">
        <div class="zoom">
          <button data-act="zoom-out" title="缩小">－</button>
          <span class="zoom-val" id="zoom-val">适应</span>
          <button data-act="zoom-in" title="放大">＋</button>
          <button data-act="zoom-fit" title="适应宽度">适应</button>
        </div>
        <button class="btn ghost small" data-act="quit">回首页</button>
      </div>
    </div>

    <div class="rv-note">
      <p><b>框是半透明的，方便你核对。</b>导出的打码件是不透明实色，盖住的内容看不见。</p>
      <p><b>照片、公章、签名机器认不出。</b>这三类要自己拖框。</p>
    </div>

    <div class="rv-body">
      <aside class="rv-rail" id="rv-rail"></aside>

      <div class="rv-stage-wrap" id="rv-wrap">
        <div class="rv-stage" id="rv-stage">
          <canvas id="rv-canvas"></canvas>
          <div class="rv-overlay" id="rv-overlay"></div>
        </div>
        <div class="stage-loading" id="rv-loading">正在打开…</div>
      </div>

      <aside class="rv-tools" id="rv-tools"></aside>
    </div>

    <div class="rv-foot">
      <button class="btn quietbtn" data-act="prev">‹ 上一页</button>
      <button class="btn quietbtn" data-act="next">下一页 ›</button>
      <span class="rv-hint" id="rv-hint"></span>
      <span class="spacer"></span>
      <button class="btn" data-act="finish">完成本文件</button>
    </div>
  </section>`
}

function toolsHtml() {
  const fill = store.readFill()
  const hasText = f.pages[pi] && f.pages[pi].hasText
  const rects = getRects()
  const pending = rects.filter(r => !r.accepted).length
  return `
    <div class="tool-group">
      <div class="rail-title">加遮盖</div>
      <button class="tool-btn ${mode === 'box' ? 'on' : ''}" data-act="mode-box">
        拖框选<span class="tool-key">B</span>
      </button>
      <div class="tool-note">任何材料都能用。按住左键拖出一个矩形，可以连着画好几个。</div>
      <button class="tool-btn ${mode === 'text' ? 'on' : ''}" data-act="mode-text" ${hasText ? '' : 'disabled'}>
        点字选<span class="tool-key">T</span>
      </button>
      <div class="tool-note">${hasText
        ? '在字上划过，划到的字合成一个框，比拖框准。'
        : '这一页没有文字层（扫描件或图片），只能拖框。'}</div>
      <button class="tool-btn ${mode === 'edit' ? 'on' : ''}" data-act="mode-edit">
        改已有的框<span class="tool-key">V</span>
      </button>
      <div class="tool-note">点框可取消，拖动可移位，右下角小圆点可改大小。</div>
    </div>

    <div class="tool-group">
      <div class="rail-title">本页</div>
      <button class="tool-btn" data-act="accept-all" ${pending ? '' : 'disabled'}>全部采纳${pending ? '（' + pending + '）' : ''}</button>
      <button class="tool-btn" data-act="undo" ${history.length ? '' : 'disabled'}>撤销<span class="tool-key">Ctrl Z</span></button>
      <button class="tool-btn ${sel ? '' : 'off'}" data-act="del">删除选中的框<span class="tool-key">Del</span></button>
      <button class="tool-btn" data-act="redetect" ${hasText ? '' : 'disabled'}>重新自动识别</button>
    </div>

    <div class="tool-group">
      <button class="fill-head" data-act="fill-toggle" aria-expanded="${fillOpen}">
        <span class="rail-title" style="margin:0">遮盖颜色</span>
        <span class="fill-now" style="--sw:${fill};--sw-line:${store.fillInfo(fill).line}"></span>
        <span class="fill-name">${esc(store.fillInfo(fill).name)}</span>
        <span class="fill-caret">${fillOpen ? '收起' : '更改'}</span>
      </button>
      ${fillOpen ? `
      <div class="swatches">
        ${store.FILLS.map(c => `<button class="swatch ${c.hex === fill ? 'on' : ''}" data-act="fill" data-hex="${c.hex}"
          title="${c.name}" style="--sw:${c.hex};--sw-line:${c.line}"><span>${c.name}</span></button>`).join('')}
      </div>
      <div class="tool-note">只影响导出的打码件，屏幕上始终半透明。</div>` : ''}
    </div>

    <div class="tool-group">
      <div class="rail-title">要盖住的</div>
      <ul class="checklist">
        <li>姓名（含签名）</li>
        <li>单位（含公章上的字）</li>
        <li>照片</li>
        <li>身份证号</li>
      </ul>
    </div>`
}

/* ---------------- 数据 ---------------- */

function getRects() { return f.pageRects[pi] || [] }

function setRects(list, pushHistory) {
  if (pushHistory) {
    history = history.concat([JSON.stringify(getRects())]).slice(-HISTORY_MAX)
  }
  f.pageRects[pi] = list
  paintBoxes()
  paintCounts()
  paintRail()
  paintTools()
}

/* ---------------- 翻页与渲染 ---------------- */

async function loadPage(index) {
  if (!mounted) return
  pi = index
  sel = null
  draft = null
  picks = []
  picked = null
  history = []
  lines = null
  indexed = []
  const token = ++renderToken

  $('#rv-loading').hidden = false
  $('#rv-loading').textContent = f.type === 'pdf' ? '正在渲染第 ' + (index + 1) + ' 页…' : '正在打开图片…'
  $('#rv-stage').style.visibility = 'hidden'
  paintTools()
  paintRail()

  try {
    unit = { w: f.pages[index].w, h: f.pages[index].h }
    layout()
    await paintPage(token)
    if (token !== renderToken || !mounted) return

    if (f.type === 'pdf') {
      await ensureLines(index)
      if (token !== renderToken || !mounted) return
      await autoDetect()
      if (token !== renderToken || !mounted) return
    }

    $('#rv-loading').hidden = true
    $('#rv-stage').style.visibility = 'visible'
    if (mode === 'text' && !f.pages[pi].hasText) mode = 'edit'
    paintBoxes()
    paintCounts()
    paintTools()
    paintRail()
    hint()
  } catch (e) {
    $('#rv-loading').textContent = (e && e.message) || '这一页打不开'
    await alertBox({ title: '这一页打不开', body: (e && e.message) || '可以先跳过它，其余页照常。' })
  }
}

/** 把当前页画到画布上。渲染倍数跟着缩放走，放大了不会糊。 */
async function paintPage(token) {
  const canvas = $('#rv-canvas')
  if (f.type === 'pdf') {
    const dpr = window.devicePixelRatio || 1
    const scale = Math.min(3, Math.max(1.2, dispScale * dpr))
    await pdfdoc.renderPage(f.pdf.doc, pi, scale, canvas)
  } else {
    const bmp = f.bitmap || (f.bitmap = await loadBitmap(f.blob))
    if (token !== renderToken) return
    canvas.width = unit.w
    canvas.height = unit.h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  }
}

async function ensureLines(index) {
  const key = f.id + ':' + index
  if (linesCache.has(key)) {
    lines = linesCache.get(key)
  } else {
    lines = await pdfdoc.textLines(f.pdf.doc, index)
    linesCache.set(key, lines)
  }
  indexed = textpick.index(lines)
  const chars = lines.reduce((n, ln) => n + ln.t.trim().length, 0)
  f.pages[index].hasText = chars >= pdfdoc.MIN_TEXT_CHARS
}

/**
 * 通读整本，把每一页该盖的地方先找出来。
 *
 * 为什么不等翻到那页再说：页栏上每页的角标就是让你一眼看出哪几页要动手的。
 * 要是只算当前页，你在第 1 页点「完成本文件」，后面几页的姓名单位就一起漏了。
 * 读文字层比渲染便宜得多，几十页也就一两秒。
 */
async function prescan() {
  if (!mounted || !f || f.type !== 'pdf' || f.prescanned) return
  const token = fileToken          // 翻页不该打断通读，切文件才打断
  f.prescanned = true
  const profile = store.readProfile()
  for (let i = 0; i < f.pages.length; i++) {
    if (fileToken !== token) return            // 已经切走了，别再动这个文件
    if (i === pi) continue                     // 当前页 loadPage 里做过了
    const key = f.id + ':' + i
    let ln = linesCache.get(key)
    if (!ln) {
      ln = await pdfdoc.textLines(f.pdf.doc, i)
      linesCache.set(key, ln)
    }
    f.pages[i].hasText = ln.reduce((n, x) => n + x.t.trim().length, 0) >= pdfdoc.MIN_TEXT_CHARS
    if (!f.pageRects[i] && !f.autoDetected[i]) {
      f.autoDetected[i] = true
      if (f.pages[i].hasText) {
        const found = detectLines(ln, profile)
        if (found.length) f.pageRects[i] = found
      }
    }
    if (fileToken === token) { paintRail(); paintCounts() }
  }
}

/** 这一页第一次打开、又还没有任何框时，跑一次识别 */
async function autoDetect() {
  if (f.pageRects[pi] || f.autoDetected[pi]) return
  f.autoDetected[pi] = true
  if (!f.pages[pi].hasText) return
  const found = detectLines(lines, store.readProfile())
  if (found.length) {
    f.pageRects[pi] = found
    toast('本页自动找到 ' + found.length + ' 处，请逐个核对')
  }
}

/** 计算显示倍数与舞台尺寸 */
function layout() {
  if (!mounted) return
  const wrap = $('#rv-wrap')
  if (!wrap || !unit.w) return
  const avail = Math.max(240, wrap.clientWidth - 44)
  const fit = avail / unit.w
  dispScale = fit * zoom
  const stage = $('#rv-stage')
  stage.style.width = Math.round(unit.w * dispScale) + 'px'
  stage.style.height = Math.round(unit.h * dispScale) + 'px'
  $('#zoom-val').textContent = zoom === 1 ? '适应' : Math.round(zoom * 100) + '%'
  paintBoxes()
}

/* ---------------- 画框 ---------------- */

function paintBoxes() {
  if (!mounted) return
  const overlay = $('#rv-overlay')
  if (!overlay) return
  const k = dispScale
  const html = getRects().map(r => {
    const cls = 'bx ' + (r.accepted ? 'bx-on' : 'bx-off') + (r.id === sel ? ' bx-sel' : '')
    return `<div class="${cls}" data-id="${r.id}"
      style="left:${(r.x * k).toFixed(1)}px;top:${(r.y * k).toFixed(1)}px;width:${(r.w * k).toFixed(1)}px;height:${(r.h * k).toFixed(1)}px">
      <span class="bx-label">${esc(r.label)}${r.accepted ? '' : '?'}</span>
      ${r.accepted ? '<span class="bx-handle"></span>' : ''}
    </div>`
  }).join('')
  const pickHtml = picks.map(p => `<div class="pick" style="left:${(p.x * k).toFixed(1)}px;top:${(p.y * k).toFixed(1)}px;width:${(p.w * k).toFixed(1)}px;height:${(p.h * k).toFixed(1)}px"></div>`).join('')
  const draftHtml = draft
    ? `<div class="draft" style="left:${draft.x}px;top:${draft.y}px;width:${draft.w}px;height:${draft.h}px"></div>`
    : ''
  overlay.innerHTML = html + pickHtml + draftHtml
  const stage = $('#rv-stage')
  stage.className = 'rv-stage mode-' + mode
  applyFill(stage)
}

/** 把当前遮盖色写成 CSS 变量：屏幕上用同一个色、但半透明，出件才是实色 */
function applyFill(stage) {
  const info = store.fillInfo(store.readFill())
  const hex = info.hex.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16)
  stage.style.setProperty('--fill-rgb', r + ',' + g + ',' + b)
  stage.style.setProperty('--fill-line', info.line)
}

function paintCounts() {
  if (!mounted) return
  const rects = getRects()
  const on = rects.filter(r => r.accepted).length
  const off = rects.length - on
  const total = job.acceptedCount(f)
  $('#rv-count').textContent =
    '第 ' + (pi + 1) + '/' + f.pages.length + ' 页 · 本页 ' + on + ' 处将被盖住' +
    (off ? '，' + off + ' 处待确认' : '') +
    (f.pages.length > 1 ? ' · 全文件共 ' + total + ' 处' : '')
}

function paintTools() {
  if (!mounted) return
  const box = $('#rv-tools')
  if (box) box.innerHTML = toolsHtml()
}

function paintRail() {
  if (!mounted) return
  const rail = $('#rv-rail')
  if (!rail) return
  const j = job.current()
  const pages = f.pages.map((p, i) => {
    const n = (f.pageRects[i] || []).filter(r => r.accepted).length
    return `<button class="rail-page ${i === pi ? 'on' : ''}" data-act="page" data-i="${i}">
      <span>第 ${i + 1} 页</span>${n ? '<span class="rail-badge">' + n + '</span>' : ''}
    </button>`
  }).join('')
  const files = j.files.length > 1
    ? '<div class="rail-title" style="margin-top:18px">本批次 ' + j.files.length + ' 个文件</div>' +
      j.files.map(x => `<button class="rail-file ${x.id === f.id ? 'on' : ''} ${x.reviewed ? 'done' : ''}"
        data-act="file" data-id="${x.id}">${x.reviewed ? '✓ ' : ''}${esc(x.name)}</button>`).join('')
    : ''
  rail.innerHTML = '<div class="rail-title">' + (f.type === 'pdf' ? f.pages.length + ' 页' : '单页') + '</div>' + pages + files
}

function hint() {
  if (!mounted) return
  const el = $('#rv-hint')
  if (!el) return
  if (mode === 'box') el.textContent = '按住左键拖出要盖住的范围'
  else if (mode === 'text') el.textContent = '在字上划过'
  else {
    const pending = getRects().filter(r => r.accepted === false).length
    el.textContent = pending ? '虚线框是没把握的，点一下才会盖住' : '点框可取消，拖动可移位'
  }
}

/* ---------------- 鼠标与手指 ---------------- */

function stagePoint(e) {
  const rect = $('#rv-stage').getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function toUnit(p) { return { x: p.x / dispScale, y: p.y / dispScale } }

function hitTest(px, py) {
  const rects = getRects()
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    const x = r.x * dispScale, y = r.y * dispScale
    const w = r.w * dispScale, h = r.h * dispScale
    if (r.accepted &&
        px >= x + w - HANDLE && px <= x + w + HANDLE &&
        py >= y + h - HANDLE && py <= y + h + HANDLE) {
      return { index: i, how: 'resize' }
    }
    if (px >= x && px <= x + w && py >= y && py <= y + h) {
      return { index: i, how: 'move' }
    }
  }
  return null
}

function bindStage() {
  const stage = $('#rv-stage')

  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    const p = stagePoint(e)
    // 捕获指针，鼠标划出画布外也能继续。个别浏览器对合成事件会抛错，不该因此卡住。
    try { stage.setPointerCapture(e.pointerId) } catch (err) { /* 没有捕获也能画，只是出界后要松手 */ }
    gesture = { startX: p.x, startY: p.y, moved: 0 }

    if (mode === 'text') {
      gesture.how = 'pick'
      picked = new Set()
      addPick(p)
      return
    }
    if (mode === 'box') {
      gesture.how = 'draw'
      draft = { x: p.x, y: p.y, w: 0, h: 0 }
      paintBoxes()
      return
    }
    const hit = hitTest(p.x, p.y)
    if (!hit) { gesture = null; if (sel) { sel = null; paintBoxes(); paintTools() } return }
    const r = getRects()[hit.index]
    gesture.how = hit.how
    gesture.index = hit.index
    gesture.origin = { x: r.x, y: r.y, w: r.w, h: r.h }
    gesture.snapshot = JSON.stringify(getRects())
    sel = r.id
    paintBoxes()
    paintTools()
  })

  stage.addEventListener('pointermove', e => {
    if (!gesture) return
    const p = stagePoint(e)
    const dx = p.x - gesture.startX
    const dy = p.y - gesture.startY
    gesture.moved = Math.max(gesture.moved, Math.abs(dx) + Math.abs(dy))

    if (gesture.how === 'pick') { addPick(p); return }
    if (gesture.how === 'draw') {
      draft = { x: Math.min(gesture.startX, p.x), y: Math.min(gesture.startY, p.y), w: Math.abs(dx), h: Math.abs(dy) }
      paintBoxes()
      return
    }
    if (gesture.moved < TAP_SLOP) return

    const o = gesture.origin
    const list = getRects().map(r => Object.assign({}, r))
    const r = list[gesture.index]
    if (gesture.how === 'move') {
      r.x = Math.max(0, Math.min(o.x + dx / dispScale, unit.w - o.w))
      r.y = Math.max(0, Math.min(o.y + dy / dispScale, unit.h - o.h))
    } else {
      r.w = Math.max(3, Math.min(o.w + dx / dispScale, unit.w - o.x))
      r.h = Math.max(3, Math.min(o.h + dy / dispScale, unit.h - o.y))
    }
    r.accepted = true
    f.pageRects[pi] = list
    paintBoxes()
    paintCounts()
  })

  const end = () => {
    const g = gesture
    gesture = null
    if (!g) return

    if (g.how === 'pick') {
      const keys = Array.from(picked || [])
      picked = null
      picks = []
      if (!keys.length) { paintBoxes(); toast('没选到字，可以改用拖框选'); return }
      setRects(getRects().concat(textpick.toRects(indexed, keys)), true)
      toast('已盖住 ' + keys.length + ' 个字')
      return
    }

    if (g.how === 'draw') {
      const d = draft
      draft = null
      if (!d || d.w < MIN_DRAW || d.h < MIN_DRAW) { paintBoxes(); toast('框太小，已放弃'); return }
      const r = textpick.makeRect({
        x: d.x / dispScale, y: d.y / dispScale, w: d.w / dispScale, h: d.h / dispScale,
        kind: 'manual', label: '手动', source: 'manual'
      })
      sel = r.id
      setRects(getRects().concat([r]), true)
      return
    }

    if (g.moved < TAP_SLOP) {
      // 点一下：识别出来的框在「盖 / 不盖」之间切，自己画的框点一下就删
      const list = getRects().map(r => Object.assign({}, r))
      const r = list[g.index]
      if (!r) return
      if (r.source === 'auto') r.accepted = !r.accepted
      else list.splice(g.index, 1)
      setRects(list, true)
      hint()
      return
    }
    if (g.snapshot) {
      history = history.concat([g.snapshot]).slice(-HISTORY_MAX)
      paintTools()
    }
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('contextmenu', e => e.preventDefault())

  // 工具栏、页栏、底栏的按钮统一在这里接
  $('.review').addEventListener('click', onClick)
}

function addPick(p) {
  if (!indexed.length || !picked) return
  const u = toUnit(p)
  const key = textpick.hit(indexed, u.x, u.y)
  if (!key || picked.has(key)) return
  picked.add(key)
  picks = textpick.highlights(indexed, Array.from(picked))
  paintBoxes()
}

/* ---------------- 按钮与快捷键 ---------------- */

async function onClick(e) {
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  const act = btn.dataset.act

  if (act === 'mode-box') { mode = mode === 'box' ? 'edit' : 'box'; paintTools(); paintBoxes(); hint() }
  else if (act === 'mode-text') { mode = mode === 'text' ? 'edit' : 'text'; paintTools(); paintBoxes(); hint() }
  else if (act === 'mode-edit') { mode = 'edit'; draft = null; picks = []; paintTools(); paintBoxes(); hint() }
  else if (act === 'fill-toggle') { fillOpen = !fillOpen; paintTools() }
  else if (act === 'fill') { store.writeFill(btn.dataset.hex); fillOpen = false; paintTools(); paintBoxes(); toast('导出用' + store.fillInfo(btn.dataset.hex).name + '色实色块盖住') }
  else if (act === 'accept-all') setRects(getRects().map(r => Object.assign({}, r, { accepted: true })), true)
  else if (act === 'undo') undo()
  else if (act === 'del') { if (!sel) { toast('先点一下某个框把它选中，再删'); return } delSelected() }
  else if (act === 'redetect') await redetect()
  else if (act === 'page') await gotoPage(Number(btn.dataset.i))
  else if (act === 'file') switchFile(btn.dataset.id)
  else if (act === 'prev') await gotoPage(pi - 1)
  else if (act === 'next') await gotoPage(pi + 1)
  else if (act === 'zoom-in') setZoom(zoom * 1.25)
  else if (act === 'zoom-out') setZoom(zoom / 1.25)
  else if (act === 'zoom-fit') setZoom(1)
  else if (act === 'finish') await finish()
  else if (act === 'quit') await quit()
}

function setZoom(z) {
  const next = Math.min(4, Math.max(0.4, z))
  if (Math.abs(next - zoom) < 0.001) return
  zoom = next
  layout()
  if (f.type === 'pdf') schedulePageRepaint()
}

let repaintTimer = null
function schedulePageRepaint() {
  clearTimeout(repaintTimer)
  repaintTimer = setTimeout(() => {
    const token = renderToken
    paintPage(token).then(() => { if (token === renderToken) paintBoxes() }).catch(() => {})
  }, 180)
}

function undo() {
  const stack = history.slice()
  const last = stack.pop()
  if (!last) return
  history = stack
  f.pageRects[pi] = JSON.parse(last)
  sel = null
  paintBoxes(); paintCounts(); paintRail(); paintTools(); hint()
}

function delSelected() {
  if (!sel) return
  const list = getRects().filter(r => r.id !== sel)
  sel = null
  setRects(list, true)
}

async function redetect() {
  if (!f.pages[pi].hasText) return
  const found = detectLines(lines, store.readProfile())
  if (!found.length) {
    await alertBox({
      title: '这一页没查到',
      body: '文字层里找不到你设置的姓名或单位。也许这一页确实没有，也许材料里的写法和你填的不一样（比如带了「（盖章）」）。可以用拖框选自己盖。'
    })
    return
  }
  const keep = getRects().filter(r => r.source !== 'auto')
  setRects(keep.concat(found), true)
  toast('重新找到 ' + found.length + ' 处')
}

async function gotoPage(index) {
  if (index < 0 || index >= f.pages.length || index === pi) return
  await loadPage(index)
}

function switchFile(id) {
  if (id === f.id) return
  go('/review/' + id)
}

async function finish() {
  const total = job.acceptedCount(f)
  const pagesWith = Object.keys(f.pageRects).filter(k => f.pageRects[k].some(r => r.accepted)).length
  const pending = Object.keys(f.pageRects).reduce((n, k) => n + f.pageRects[k].filter(r => !r.accepted).length, 0)

  if (!total) {
    const yes = await confirmBox({
      title: '整个文件都不盖？',
      body: '如果确实没有你的姓名、单位、照片或证件号，可以直接跳过；交材料时用原件即可。',
      ok: '确认跳过'
    })
    if (!yes) return
    mark(true)
    return
  }

  const yes = await confirmBox({
    title: f.pages.length > 1 ? '这个文件确认好了吗？' : '这一页已经盖住了吗？',
    body: '姓名 · 单位 · 照片 · 身份证号 · 公章 · 签名\n' +
      (f.pages.length > 1 ? pagesWith + ' 页共 ' + total + ' 处将被盖住。' : total + ' 处将被盖住。') +
      (pending ? '\n还有 ' + pending + ' 处待确认的虚线框不会被盖住。' : ''),
    ok: '确认'
  })
  if (yes) mark(false)
}

function mark(skipped) {
  f.reviewed = true
  f.skipped = skipped
  f.status = 'reviewed'
  const next = job.nextUnreviewed(f.id)
  if (next) {
    toast('还有 ' + job.counts().unreviewed + ' 个文件没审')
    go('/review/' + next.id)
  } else {
    go('/result')
  }
}

async function quit() {
  const yes = await confirmBox({
    title: '回首页？',
    body: '这一批的文件和框都会丢掉，要重新选。',
    ok: '回去', danger: true
  })
  if (yes) { job.reset(); go('/') }
}

function bindKeys() {
  const onKey = e => {
    if (!$('#modal').hidden) return
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea') return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delSelected(); return }
    if (e.key === 'Escape') { mode = 'edit'; draft = null; picks = []; sel = null; paintTools(); paintBoxes(); hint(); return }
    if (e.key === 'ArrowLeft') { gotoPage(pi - 1); return }
    if (e.key === 'ArrowRight') { gotoPage(pi + 1); return }
    const k = e.key.toLowerCase()
    if (k === 'b') { mode = mode === 'box' ? 'edit' : 'box'; paintTools(); paintBoxes(); hint() }
    else if (k === 't') { if (f.pages[pi] && f.pages[pi].hasText) { mode = mode === 'text' ? 'edit' : 'text'; paintTools(); paintBoxes(); hint() } }
    else if (k === 'v') { mode = 'edit'; paintTools(); paintBoxes(); hint() }
  }
  document.addEventListener('keydown', onKey)
  return () => document.removeEventListener('keydown', onKey)
}
