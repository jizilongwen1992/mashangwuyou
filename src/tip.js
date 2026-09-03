/**
 * 赞赏板块。纯静态：页面上放两张收款码图片，扫码随意给，不给一样用。
 *
 * 为什么不做成收费：接支付要商户号、要一台服务器验单，那就得有后端，
 * 「文件不出本机」这条根本承诺就得重写。打赏是个人间赠与，两张图片就够了。
 *
 * 图片不存在时整块自动隐藏——所以没准备好图片也可以先上线，不会露出空框。
 */

import { esc } from './ui/kit.js?v=20260903172307'

export const TIP = {
  enabled: true,
  text: '如果这个工具为您提供了方便，不妨给作者一点鼓励～',
  // 两张都是重新生成的干净码（720×720，纠错 H，中间是平台图标），
  // 不是海报截图——海报上有实名和头像，而且两家尺寸对不齐。
  // 两张收款码放 assets/ 下，文件名照这里写。只要「收款码」，别放「付款码」。
  codes: [
    { src: 'assets/收款码_微信.png', label: '微信' },
    { src: 'assets/收款码_支付宝.png', label: '支付宝' }
  ]
}

/**
 * 探一次哪些收款码图片真的存在，全站共用这个结果。
 * 页脚和出件页各探一遍会在控制台留四个 404，共用就只剩两个——
 * 同事一开控制台看到一排红字会疑心，能少就少。
 */
let availablePromise = null
export function available() {
  if (!TIP.enabled) return Promise.resolve([])
  if (!availablePromise) {
    availablePromise = Promise.all(TIP.codes.map(q => new Promise(res => {
      const im = new Image()
      im.onload = () => res(q)
      im.onerror = () => res(null)
      im.src = q.src
    }))).then(list => list.filter(Boolean))
  }
  return availablePromise
}

/** 赞赏卡片的 HTML；一张图都没有就返回空串 */
export async function tipHtml(compact) {
  const codes = await available()
  if (!codes.length) return ''
  return `
  <section class="tip ${compact ? 'tip-compact' : ''}">
    ${TIP.text ? `<p class="tip-text">${esc(TIP.text)}</p>` : ''}
    <div class="tip-qrs">
      ${codes.map(q => `
      <figure class="tip-qr">
        <img src="${esc(q.src)}" alt="${esc(q.label)}收款码">
      </figure>`).join('')}
    </div>
  </section>`
}

/**
 * 装好之后调一次，兜底：探测通过之后图片又没了（极少见），把那张卡拿掉。
 * 要紧跟 innerHTML 赋值调用，图片还没开始加载，error 事件不会漏掉。
 */
export function mountTip(root) {
  ;(root || document).querySelectorAll('.tip').forEach(sec => {
    const imgs = Array.from(sec.querySelectorAll('.tip-qr img'))
    let alive = imgs.length
    const drop = img => {
      const fig = img.closest('.tip-qr')
      if (fig) fig.remove()
      if (--alive <= 0) sec.remove()
    }
    imgs.forEach(img => {
      if (img.complete && img.naturalWidth === 0) { drop(img); return }   // 缓存里的 404
      img.addEventListener('error', () => drop(img), { once: true })
    })
    if (!imgs.length) sec.remove()
  })
}
