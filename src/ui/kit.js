/** 小工具：转义、查询、吐司、弹窗、下载。没有框架，够用就行。 */

export const $ = (sel, root) => (root || document).querySelector(sel)
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))

/** 文件名、单位名都可能带尖括号，拼进 HTML 前必须转义 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

export function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

let toastTimer = null
export function toast(msg, ms) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, ms || 2200)
}

function openModal(html) {
  const el = $('#modal')
  el.innerHTML = '<div class="modal-box">' + html + '</div>'
  el.hidden = false
  return el
}

export function closeModal() {
  const el = $('#modal')
  el.hidden = true
  el.innerHTML = ''
}

/** @returns {Promise<boolean>} 点了确认为 true */
export function confirmBox({ title, body, ok = '确认', cancel = '再看看', danger = false }) {
  return new Promise(resolve => {
    const el = openModal(
      '<div class="modal-title">' + esc(title) + '</div>' +
      '<div class="modal-body">' + esc(body || '') + '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn quietbtn" data-act="cancel">' + esc(cancel) + '</button>' +
        '<button class="btn' + (danger ? ' danger' : '') + '" data-act="ok">' + esc(ok) + '</button>' +
      '</div>'
    )
    const done = v => { closeModal(); resolve(v) }
    el.onclick = e => {
      const act = e.target.dataset.act
      if (act === 'ok') done(true)
      else if (act === 'cancel' || e.target === el) done(false)
    }
    const key = e => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', key); done(false) }
      if (e.key === 'Enter') { document.removeEventListener('keydown', key); done(true) }
    }
    document.addEventListener('keydown', key)
  })
}

export function alertBox({ title, body, ok = '知道了' }) {
  return new Promise(resolve => {
    const el = openModal(
      '<div class="modal-title">' + esc(title) + '</div>' +
      '<div class="modal-body">' + esc(body || '') + '</div>' +
      '<div class="modal-foot"><button class="btn" data-act="ok">' + esc(ok) + '</button></div>'
    )
    const done = () => { closeModal(); resolve() }
    el.onclick = e => { if (e.target.dataset.act === 'ok' || e.target === el) done() }
  })
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 打码件的文件名：原名后面加 _打码 */
export function outName(name, ext) {
  const i = name.lastIndexOf('.')
  const base = i > 0 ? name.slice(0, i) : name
  return base + '_打码.' + ext
}
