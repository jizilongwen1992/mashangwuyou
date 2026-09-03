/**
 * 路由与装配。地址栏用 hash，浏览器的前进后退能用。
 *   #/            首页
 *   #/review/f1   审阅某个文件
 *   #/result      出件
 *   #/guide       打码要求
 *   #/privacy     隐私说明
 */

import { $, $$ } from './ui/kit.js?v=20260903163236'
import * as home from './ui/home.js?v=20260903163236'
import * as review from './ui/review.js?v=20260903163236'
import * as result from './ui/result.js?v=20260903163236'
import * as doc from './ui/doc.js?v=20260903163236'

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
  // 换一个全新的容器节点，而不是只清 innerHTML：
  // 上一页 addEventListener 挂在容器上的监听会跟着旧节点一起被扔掉。
  // 曾经栽过：首页和审阅页都有个 data-act="clear" 的按钮，首页的监听没摘，
  // 审阅页点「清空本页」弹出来的却是「清除这台电脑上的信息？」，确认一下姓名单位就没了。
  const old = $('#view')
  const root = old.cloneNode(false)
  old.replaceWith(root)
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
  const { available, tipHtml, mountTip } = await import('./tip.js?v=20260903163236')
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
