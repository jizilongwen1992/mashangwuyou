/**
 * 路由与装配。地址栏用 hash，浏览器的前进后退能用。
 *   #/            工作台
 *   #/review/f1   审阅某个文件
 *   #/result      出件
 *   #/guide       打码要求
 *   #/privacy     隐私说明
 */

import { $, $$ } from './ui/kit.js'
import * as home from './ui/home.js'
import * as review from './ui/review.js'
import * as result from './ui/result.js'
import * as doc from './ui/doc.js'

const VIEWS = {
  home: home.render,
  review: review.render,
  result: result.render,
  guide: doc.renderGuide,
  privacy: doc.renderPrivacy
}

let leaving = null

export function go(path) {
  location.hash = path
}

function parse() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length) return { name: 'home', args: [] }
  return { name: parts[0], args: parts.slice(1) }
}

async function mount() {
  if (leaving) { try { leaving() } catch (e) { /* 上一页的清理失败不该拦住下一页 */ } leaving = null }
  const { name, args } = parse()
  const render = VIEWS[name] || VIEWS.home
  const root = $('#view')
  root.className = 'view' + (name === 'review' ? ' wide' : '')
  root.innerHTML = ''
  document.querySelector('.foot').hidden = name === 'review'
  $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.route === name))
  window.scrollTo(0, 0)
  leaving = (await render(root, args)) || null
}

window.addEventListener('hashchange', mount)
mount()

// 页脚的「赞赏」：先探一下有没有收款码图片，有才把链接放出来
;(async () => {
  const { available, tipHtml, mountTip } = await import('./tip.js')
  const link = $('#tip-link')
  if (!link || !(await available()).length) return
  link.hidden = false
  link.addEventListener('click', async e => {
    e.preventDefault()
    const el = $('#modal')
    el.innerHTML = '<div class="modal-box modal-tip">' + (await tipHtml(false)) +
      '<div class="modal-foot"><button class="btn quietbtn" data-act="ok">关闭</button></div></div>'
    el.hidden = false
    mountTip(el)
    el.onclick = ev => { if (ev.target.dataset.act === 'ok' || ev.target === el) { el.hidden = true; el.innerHTML = '' } }
  })
})()
