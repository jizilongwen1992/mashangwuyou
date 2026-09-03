/** 出件页：逐个生成打码件，做一次漏打自检，然后交给你下载。 */

import { $, esc, fmtSize, toast, download, outName, alertBox } from './kit.js'
import * as job from '../job.js'
import * as store from '../store.js'
import { exportImage, loadBitmap } from '../redact.js'
import { buildPdf, scanLeaks } from '../pdfout.js'
import { go } from '../main.js'

let items = []
let running = false
let thumbs = []        // 图片出件的缩略图地址，离开本页时回收
let mounted = false    // 出件是长活，人可能中途走掉；走了就别再碰 DOM

export function render(root) {
  const j = job.current()
  if (!j) { go('/'); return }

  items = j.files.map(f => ({
    id: f.id,
    name: f.name,
    isPdf: f.type === 'pdf',
    outName: outName(f.name, f.type === 'pdf' ? 'pdf' : 'jpg'),
    state: 'queued',
    note: '排队中',
    blob: null,
    thumb: '',
    leaks: []
  }))

  root.innerHTML = shell()
  root.addEventListener('click', onClick)
  mounted = true
  paint()
  // 不 await：一份几十页的 PDF 要跑一会儿，清理函数得先交出去，
  // 否则人中途点了导航，上一页的清理就赶不上。
  runAll()
  return () => {
    mounted = false
    thumbs.forEach(u => URL.revokeObjectURL(u))
    thumbs = []
  }
}

function shell() {
  return `
  <h1 class="hero-title" id="rs-title">正在出件…</h1>
  <p class="hero-desc" id="rs-sub">打码件在你的浏览器里生成，生成完点下载才会落到硬盘上。</p>
  <div class="progress"><i id="rs-bar" style="width:0%"></i></div>
  <div id="rs-list" class="filelist"></div>
  <div id="rs-leaks"></div>
  <div class="notice plain">
    <div class="notice-title">别忘了通知要求交 2 份</div>
    1 份原始扫描件，1 份就是这里生成的打码件。原件没有被改动。
  </div>
  <div class="btnbar">
    <button class="btn" data-act="zip" disabled>打包下载全部</button>
    <button class="btn ghost" data-act="again">再打一批</button>
  </div>`
}

/* ---------------- 出件 ---------------- */

async function runAll() {
  running = true
  for (const item of items) {
    if (item.state === 'done') continue
    await runOne(item)
  }
  running = false
  if (!mounted) return
  const done = items.filter(i => i.blob).length
  const bad = items.filter(i => i.state === 'error').length
  $('#rs-title').textContent = bad ? '部分文件没能出件' : '打码件已生成'
  $('#rs-sub').textContent = done
    ? '共 ' + done + ' 个打码件。下载后请自己再看一眼，尤其是照片、公章、签名这些机器认不出来的地方。'
    : '这一批没有需要打码的内容，直接用原件即可。'
  paint()
  paintLeaks()
}

async function runOne(item) {
  const f = job.file(item.id)
  if (!f) return
  patch(item, { state: 'running', note: '出件中…' })
  try {
    const total = job.acceptedCount(f)
    if (!total) {
      patch(item, { state: 'skip', note: '没有要盖的地方，交原件即可', blob: null })
      f.status = 'done'
      return
    }
    if (item.isPdf) {
      const blob = await buildPdf(f, (n, all) => patch(item, { note: '出件中 ' + n + '/' + all + ' 页…' }))
      patch(item, { note: '正在自检…' })
      const check = await scanLeaks(blob, store.readProfile())
      f.output = blob
      f.status = 'done'
      patch(item, {
        state: 'done',
        blob,
        leaks: check.leaks,
        note: total + ' 处已盖住 · ' + fmtSize(blob.size) +
          (check.ok ? (check.leaks.length ? ' · 自检发现可能漏打' : ' · 自检通过') : ' · 自检没跑起来')
      })
    } else {
      const bmp = f.bitmap || (f.bitmap = await loadBitmap(f.blob))
      const blob = await exportImage({
        bitmap: bmp,
        width: f.pages[0].w,
        height: f.pages[0].h,
        rects: (f.pageRects[0] || []).filter(r => r.accepted)
      })
      f.output = blob
      f.status = 'done'
      const thumb = URL.createObjectURL(blob)
      thumbs.push(thumb)
      patch(item, { state: 'done', blob, thumb,
        note: total + ' 处已盖住 · ' + fmtSize(blob.size) + ' · 图片没有文字层，自检不适用' })
    }
  } catch (e) {
    f.status = 'error'
    patch(item, { state: 'error', note: (e && e.message) || '出件失败' })
  }
}

function patch(item, fields) {
  Object.assign(item, fields)
  paint()
}

/* ---------------- 画界面 ---------------- */

function paint() {
  if (!mounted) return
  const list = $('#rs-list')
  if (!list) return
  list.innerHTML = items.map((i, n) => `
    <div class="fileitem">
      <div class="filetag">${i.thumb ? '<img src="' + i.thumb + '" alt="">' : (i.isPdf ? 'PDF' : '图片')}</div>
      <div class="row-main">
        <div class="filename">${esc(i.state === 'skip' ? i.name : i.outName)}</div>
        <div class="filemeta ${i.state === 'error' ? 'err' : ''} ${i.state === 'done' && !i.leaks.length ? 'ok' : ''}">${esc(i.note)}</div>
      </div>
      ${i.blob ? '<button class="btn small" data-act="dl" data-i="' + n + '">下载</button>' : ''}
      ${i.state === 'error' ? '<button class="btn ghost small" data-act="retry" data-i="' + n + '">重试</button>' : ''}
    </div>`).join('')

  const done = items.filter(i => i.state === 'done' || i.state === 'skip' || i.state === 'error').length
  const bar = $('#rs-bar')
  if (bar) bar.style.width = Math.round(done / Math.max(1, items.length) * 100) + '%'
  const zip = document.querySelector('[data-act="zip"]')
  if (zip) zip.disabled = running || items.filter(i => i.blob).length < 1
}

function paintLeaks() {
  if (!mounted) return
  const box = $('#rs-leaks')
  if (!box) return
  const bad = items.filter(i => i.leaks && i.leaks.length)
  if (!bad.length) {
    const checked = items.filter(i => i.isPdf && i.state === 'done')
    box.innerHTML = checked.length
      ? `<div class="notice good">
           <div class="notice-title">漏打自检通过</div>
           把生成的${checked.length > 1 ? checked.length + ' 个打码件都' : '打码件'}重新读了一遍，里面查不到你的姓名、单位和身份证号。
           照片、公章、签名这类图形自检查不出来，还是要自己看一眼。
         </div>`
      : ''
    return
  }
  box.innerHTML = bad.map(i => `
    <div class="notice bad">
      <div class="notice-title">${esc(i.outName)}：可能有漏打</div>
      ${i.leaks.map(l => '第 ' + l.page + ' 页还能查到 ' +
        l.hits.map(h => '「' + esc(h.text) + '」（' + esc(h.label) + '）').join('、')).join('<br>')}
      <div style="margin-top:8px">这些页没有打码，文字层原样保留着。回去把这几页盖上再出一次件。</div>
    </div>`).join('') +
    '<div class="btnbar"><button class="btn ghost" data-act="back">回去补打</button></div>'
}

/* ---------------- 事件 ---------------- */

async function onClick(e) {
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  if (act === 'dl') {
    const i = items[Number(btn.dataset.i)]
    if (i && i.blob) { download(i.blob, i.outName); toast('已开始下载') }
  } else if (act === 'retry') {
    const i = items[Number(btn.dataset.i)]
    if (i) await runOne(i)
  } else if (act === 'zip') {
    await zipAll()
  } else if (act === 'back') {
    const first = job.current().files.find(f => f.type === 'pdf') || job.current().files[0]
    go('/review/' + first.id)
  } else if (act === 'again') {
    job.reset()
    go('/')
  }
}

async function zipAll() {
  const ready = items.filter(i => i.blob)
  if (!ready.length) return
  if (!window.JSZip) { await alertBox({ title: '打包用的库没加载', body: '请检查 vendor/jszip.min.js 是否还在。也可以一个一个点下载。' }); return }
  toast('正在打包…')
  const zip = new window.JSZip()
  for (const i of ready) zip.file(i.outName, i.blob)
  const blob = await zip.generateAsync({ type: 'blob' })
  download(blob, '打码件_' + stamp() + '.zip')
}

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes())
}
