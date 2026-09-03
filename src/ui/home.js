/** 首页：设置要打码的信息 + 选文件 + 开始审阅。 */

import { $, esc, fmtSize, toast, confirmBox, alertBox } from './kit.js'
import * as store from '../store.js'
import * as job from '../job.js'
import * as pdfdoc from '../pdfdoc.js'
import { loadBitmap } from '../redact.js'
import { go } from '../main.js'

const MAX_MB = 50
const ACCEPT = '.jpg,.jpeg,.png,.webp,.bmp,.pdf,image/*,application/pdf'

let picked = []          // 选中但还没开始审的文件 [{name,type,size,blob,state,note,file}]
let editing = false      // 信息卡是否展开成表单

export function render(root) {
  root.innerHTML = shell()
  paintProfile()
  paintPicked()
  return bind(root)
}

/* ---------------- 骨架 ---------------- */

function shell() {
  return `
  <h1 class="hero-title">一键打码 · 码上无忧</h1>
  <p class="hero-desc">
    有文字层的 PDF 会按你设置的姓名、单位自动找出位置；扫描件和图片自己拖框。
    出件后还会把打码件再读一遍，替你查有没有漏打。
  </p>

  <div id="profile-card" class="card" style="margin-top:22px"></div>

  <div id="drop" class="drop" tabindex="0" role="button">
    <div class="drop-title">把材料拖到这里，或点击选择</div>
    <div class="drop-sub">支持 JPG / PNG / PDF，可多选 · 单个 PDF 不超过 ${MAX_MB} MB · 最多 ${pdfdoc.MAX_PAGES} 页</div>
    <input id="file-input" type="file" multiple accept="${ACCEPT}" hidden>
  </div>

  <div id="picked" class="filelist"></div>

  <div class="notice plain" style="margin-top:26px">
    <div class="notice-title">别忘了通知要求交 2 份</div>
    1 份原始扫描件，1 份打码件。本工具只另存打码件，原件一个字节都不动。
  </div>`
}

/* ---------------- 要打码的信息 ---------------- */

function paintProfile() {
  const p = store.readProfile()
  const ready = store.isReady(p)
  const box = $('#profile-card')

  if (!editing) {
    box.innerHTML = `
      <div class="row">
        <div class="card-icon">◎</div>
        <div class="row-main">
          <div class="card-title">
            <span class="${ready ? 'dot-ok' : 'dot-todo'}"></span>
            ${ready ? '要打码的信息已设置' : '先设置要打码的信息'}
          </div>
          <div class="card-sub">${ready
            ? '已设置 ' + store.categories(p).length + ' 类匹配项，自动识别按它们去查'
            : '不设置也能用，但只能全部自己拖框'}</div>
        </div>
        <button class="btn ghost small" data-act="edit">${ready ? '修改' : '去设置'}</button>
      </div>
      ${ready ? '<div class="chips">' + store.categories(p).map(c => '<span class="chip">' + esc(c) + '</span>').join('') + '</div>' : ''}
      <div class="quiet">只存在这台电脑的浏览器里，不上传。识别时在本机的 PDF 文字层里比对。</div>`
    return
  }

  box.innerHTML = `
    <div class="card-title">要打码的信息</div>
    <div class="card-sub">照评审通知，姓名、单位、身份证号要盖住。填得越全，自动找得越准。</div>
    <div class="grid2">
      <label class="field">
        <span class="field-label">姓名</span>
        <input class="input" id="p-name" value="${esc(p.name)}" placeholder="本人姓名" autocomplete="off">
      </label>
      <label class="field">
        <span class="field-label">身份证号 <span class="field-hint">选填</span></span>
        <input class="input" id="p-id" value="${esc(p.idNo)}" placeholder="18 位" autocomplete="off">
      </label>
    </div>
    <label class="field">
      <span class="field-label">单位全称</span>
      <input class="input" id="p-org" value="${esc(p.orgFull)}" placeholder="与公章上一致的全称" autocomplete="off">
    </label>
    <label class="field">
      <span class="field-label">单位简称 <span class="field-hint">选填，多个用顿号或逗号隔开</span></span>
      <input class="input" id="p-alias" value="${esc(p.orgAlias.join('、'))}" placeholder="材料里可能出现的另一种写法" autocomplete="off">
    </label>
    <div class="btnbar">
      <button class="btn" data-act="save">保存</button>
      <button class="btn quietbtn" data-act="cancel">取消</button>
      <button class="btn link" data-act="clear" style="margin-left:auto">清除这台电脑上的信息</button>
    </div>`
  setTimeout(() => { const el = $('#p-name'); if (el) el.focus() }, 0)
}

async function saveProfile() {
  const alias = ($('#p-alias').value || '').split(/[、,，;；\s]+/).map(s => s.trim()).filter(Boolean)
  const p = {
    name: $('#p-name').value.trim(),
    orgFull: $('#p-org').value.trim(),
    orgAlias: alias,
    idNo: $('#p-id').value.trim().toUpperCase()
  }
  if (p.idNo && !/^(\d{17}[\dX]|\d{15})$/.test(p.idNo)) {
    await alertBox({ title: '身份证号看着不对', body: '应当是 18 位（末位可能是 X）或 15 位。填错了识别就查不到，可以先留空。' })
    return
  }
  store.writeProfile(p)
  editing = false
  paintProfile()
  toast('已保存到本机')
}

/* ---------------- 选文件 ---------------- */

function classify(f) {
  const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf'
  return isPdf ? 'pdf' : 'image'
}

async function addFiles(list) {
  const incoming = Array.from(list || [])
  if (!incoming.length) return
  const rejected = []

  for (const f of incoming) {
    const type = classify(f)
    if (type === 'image' && !/^image\//.test(f.type) && !/\.(jpe?g|png|webp|bmp)$/i.test(f.name)) {
      rejected.push(f.name + '：不是图片也不是 PDF')
      continue
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      rejected.push(f.name + '：' + fmtSize(f.size) + '，超过 ' + MAX_MB + ' MB')
      continue
    }
    if (picked.some(p => p.name === f.name && p.size === f.size)) continue
    picked.push({ name: f.name, type, size: f.size, blob: f, state: 'loading', note: '正在打开…' })
  }
  paintPicked()

  // 逐个打开：PDF 量页数，图片量像素。这一步就能把打不开的挑出来。
  for (const item of picked.filter(p => p.state === 'loading')) {
    try {
      if (item.type === 'pdf') {
        item.pdf = await pdfdoc.open(item.blob)
        item.pages = item.pdf.pages
        item.note = item.pages.length + ' 页 · ' + fmtSize(item.size)
      } else {
        const bmp = await loadBitmap(item.blob)
        item.bitmap = bmp
        item.pages = [{ index: 0, w: bmp.width, h: bmp.height, hasText: false }]
        item.note = bmp.width + ' × ' + bmp.height + ' · ' + fmtSize(item.size)
      }
      item.state = 'ok'
    } catch (e) {
      item.state = 'error'
      item.note = (e && e.message) || '打不开'
    }
    paintPicked()
  }

  if (rejected.length) {
    await alertBox({ title: '有文件没能加进来', body: rejected.join('\n') })
  }
}

function paintPicked() {
  const box = $('#picked')
  if (!box) return
  if (!picked.length) { box.innerHTML = ''; return }

  const ok = picked.filter(p => p.state === 'ok')
  box.innerHTML =
    picked.map((p, i) => `
      <div class="fileitem">
        <div class="filetag">${p.type === 'pdf' ? 'PDF' : '图片'}</div>
        <div class="row-main">
          <div class="filename">${esc(p.name)}</div>
          <div class="filemeta ${p.state === 'error' ? 'err' : ''}">${esc(p.note || '')}</div>
        </div>
        <button class="btn link" data-act="drop-file" data-i="${i}">移除</button>
      </div>`).join('') +
    `<div class="btnbar">
      <button class="btn" data-act="start" ${ok.length ? '' : 'disabled'}>
        开始审阅${ok.length ? '（' + ok.length + ' 个文件）' : ''}
      </button>
      <button class="btn quietbtn" data-act="clear-files">清空</button>
    </div>`
}

async function start() {
  const ok = picked.filter(p => p.state === 'ok')
  if (!ok.length) return
  if (!store.isReady()) {
    const goOn = await confirmBox({
      title: '还没设置要打码的信息',
      body: '不设置也能用，但自动识别没有可比对的词，PDF 也要一个一个自己拖框。\n设置只要填姓名和单位两项。',
      ok: '仍然继续',
      cancel: '去设置'
    })
    if (!goOn) { editing = true; paintProfile(); return }
  }
  const j = job.create(ok.map(p => ({ name: p.name, type: p.type, size: p.size, blob: p.blob })))
  j.files.forEach((f, i) => {
    const src = ok[i]
    f.pages = src.pages
    f.pdf = src.pdf || null
    f.bitmap = src.bitmap || null
    f.loaded = true
  })
  picked = []
  go('/review/' + j.files[0].id)
}

/* ---------------- 事件 ---------------- */

function bind(root) {
  const drop = $('#drop')
  const input = $('#file-input')

  drop.addEventListener('click', () => input.click())
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click() } })
  input.addEventListener('change', () => { addFiles(input.files); input.value = '' })

  ;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('over')
  }))
  ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('over')
  }))
  drop.addEventListener('drop', e => addFiles(e.dataTransfer && e.dataTransfer.files))

  // 拖到页面别处不要让浏览器直接打开文件
  const swallow = e => e.preventDefault()
  window.addEventListener('dragover', swallow)
  window.addEventListener('drop', swallow)

  root.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'edit') { editing = true; paintProfile() }
    else if (act === 'cancel') { editing = false; paintProfile() }
    else if (act === 'save') saveProfile()
    else if (act === 'clear') {
      const yes = await confirmBox({
        title: '清除这台电脑上的信息？',
        body: '姓名、单位、简称、身份证号会从本浏览器删掉。已经选好的文件不受影响。',
        ok: '清除', danger: true
      })
      if (yes) { store.clearProfile(); paintProfile(); toast('已清除') }
    }
    else if (act === 'drop-file') { picked.splice(Number(btn.dataset.i), 1); paintPicked() }
    else if (act === 'clear-files') { picked = []; paintPicked() }
    else if (act === 'start') start()
  })

  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && editing && e.target.classList.contains('input')) saveProfile()
  })

  return () => {
    window.removeEventListener('dragover', swallow)
    window.removeEventListener('drop', swallow)
  }
}
