/**
 * PDF 出件。
 *
 * 为什么不能只在 PDF 上叠色块：色块是画在文字之上的图形对象，底下的文字对象还在。
 * 别人选中复制，或者用工具删掉色块，被盖住的内容原样出来，等于没打。
 *
 * 所以有打码的页一律「重新渲染成图片再装回 PDF」——文字层、图层、注释统统消失，
 * 剩下的只有像素，盖住的内容取不回来。
 * 没有打码的页原样搬过去，保留它的文字层：那一页本来就等同原件，
 * 不额外增加风险，却能省下大量体积（一份论文常常只有封面和目录两页要盖）。
 *
 * 这一段与小程序版的服务端 server/redact_pdf.py 是同一套思路，
 * 区别只是这里全在浏览器里跑，文件不出本机。
 */

import { renderPage, extractText } from './pdfdoc.js?v=20260903160348'
import { paint, canvasToBlob } from './redact.js?v=20260903160348'
import { findLeaks } from './detect.js?v=20260903160348'

export const OUTPUT_DPI = 200          // A4 约 1654 x 2339，看得清也印得出
export const JPEG_QUALITY = 0.85

function lib() {
  if (!window.PDFLib) throw new Error('缺少 vendor/pdf-lib.min.js，请检查工程文件是否完整')
  return window.PDFLib
}

/**
 * @param file 批次里的一个 PDF 文件对象（含 pdf.doc、pdf.bytes、pageRects）
 * @param onProgress (已完成页, 总页) => void
 * @returns {Promise<Blob>}
 */
export async function buildPdf(file, onProgress, fill) {
  const { PDFDocument } = lib()
  const doc = file.pdf.doc
  const total = doc.numPages

  const out = await PDFDocument.create()
  let src = null
  try {
    src = await PDFDocument.load(file.pdf.bytes, { ignoreEncryption: true })
  } catch (e) {
    src = null      // 原件搬不过来（少见的加密或畸形结构），那就整本都渲染成图片
  }

  const canvas = document.createElement('canvas')
  const scale = OUTPUT_DPI / 72

  for (let i = 0; i < total; i++) {
    const rects = (file.pageRects[i] || []).filter(r => r.accepted)
    if (!rects.length && src) {
      const [copied] = await out.copyPages(src, [i])
      out.addPage(copied)
      if (onProgress) onProgress(i + 1, total)
      continue
    }
    await renderPage(doc, i, scale, canvas)
    paint(canvas.getContext('2d'), rects, scale, fill)
    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY)
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()))
    const wPt = canvas.width / scale
    const hPt = canvas.height / scale
    const page = out.addPage([wPt, hPt])
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt })
    if (onProgress) onProgress(i + 1, total)
  }

  // 不带原文档的作者、标题、生产工具，也不带书签
  out.setTitle(''); out.setAuthor(''); out.setSubject(''); out.setKeywords([])
  out.setProducer('码上无忧'); out.setCreator('码上无忧')
  const bytes = await out.save({ useObjectStreams: true })
  return new Blob([bytes], { type: 'application/pdf' })
}

/**
 * 出件自检：把生成的 PDF 再读一遍，看哪些页还能查到你的姓名、单位、身份证号。
 *
 * 打过码的页已经是图片，查不到任何文字，这是应该的。
 * 真查到了，说明那一页你没盖——多半是漏了。这一步专门用来抓漏打。
 */
export async function scanLeaks(blob, profile) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const pages = await extractText(bytes)
    const leaks = []
    pages.forEach((text, i) => {
      const hits = findLeaks(text, profile)
      if (hits.length) leaks.push({ page: i + 1, hits })
    })
    return { ok: true, leaks }
  } catch (e) {
    return { ok: false, leaks: [], error: (e && e.message) || '自检没跑起来' }
  }
}
