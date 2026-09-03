/**
 * 打码引擎。输入一张画布 + 一组矩形，在画布上涂色；或者输入原图 + 矩形，出一张新图。
 * 不依赖页面结构，也不管坐标是从哪来的。
 *
 * 矩形坐标一律是「单位空间」——图片为自然像素，PDF 页为点。
 * 涂色时按 scale 换算到画布像素，所以出件分辨率想调多高都不会偏。
 */

export const DEFAULT_FILL = '#000000'   // 出件默认黑色实色块；界面上可选别的颜色
const MIN_BLOCK = 4

export function normalize(r) {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h)
  }
}

export function clamp(r, w, h) {
  const n = normalize(r)
  const x = Math.max(0, Math.min(n.x, w))
  const y = Math.max(0, Math.min(n.y, h))
  return { x, y, w: Math.min(n.w, w - x), h: Math.min(n.h, h - y) }
}

function paintSolid(ctx, r, fill) {
  ctx.fillStyle = fill || DEFAULT_FILL
  ctx.fillRect(r.x, r.y, r.w, r.h)
}

function paintMosaic(ctx, r, longEdge) {
  const block = Math.max(MIN_BLOCK, Math.round(longEdge / 60))
  let data
  try {
    data = ctx.getImageData(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h))
  } catch (e) {
    paintSolid(ctx, r, DEFAULT_FILL)      // 跨源画布取不到像素，退回色块
    return
  }
  const { width, height, data: px } = data
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const maxY = Math.min(by + block, height)
      const maxX = Math.min(bx + block, width)
      let rr = 0, gg = 0, bb = 0, n = 0
      for (let y = by; y < maxY; y++) {
        for (let x = bx; x < maxX; x++) {
          const i = (y * width + x) * 4
          rr += px[i]; gg += px[i + 1]; bb += px[i + 2]; n++
        }
      }
      ctx.fillStyle = `rgb(${Math.round(rr / n)},${Math.round(gg / n)},${Math.round(bb / n)})`
      ctx.fillRect(r.x + bx, r.y + by, maxX - bx, maxY - by)
    }
  }
}

/**
 * 在画布上涂掉已采纳的框。**这里涂的是不透明实色**——
 * 屏幕上审阅时看到的半透明框只是让你核对盖住了什么，出件走的是这个函数，底下什么都不剩。
 * @param ctx 画布上下文
 * @param rects 单位空间的矩形
 * @param scale 单位 -> 画布像素的倍数
 * @param fill 实色块的颜色，如 '#000000'
 */
export function paint(ctx, rects, scale, fill) {
  const k = scale || 1
  const cw = ctx.canvas.width
  const ch = ctx.canvas.height
  const longEdge = Math.max(cw, ch)
  ;(rects || []).forEach(raw => {
    if (raw.accepted === false) return
    const r = clamp({ x: raw.x * k, y: raw.y * k, w: raw.w * k, h: raw.h * k }, cw, ch)
    r.x = Math.round(r.x); r.y = Math.round(r.y)
    r.w = Math.round(r.w); r.h = Math.round(r.h)
    if (r.w < 2 || r.h < 2) return
    if (raw.style === 'mosaic') paintMosaic(ctx, r, longEdge)
    else paintSolid(ctx, r, fill)
  })
}

/** 读一张本地图片。imageOrientation 让手机照片的 EXIF 方向生效，显示与出件才一致。 */
export async function loadBitmap(blob) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch (e) { /* 老浏览器不认这个选项，往下退 */ }
    try {
      return await createImageBitmap(blob)
    } catch (e) { /* 继续退到 <img> */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片打不开')) }
    img.src = url
  })
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('出件失败：画布导不出'))), type, quality)
  })
}

/**
 * 图片出件：按原图分辨率重画一遍再涂色，原件一个字节都不动。
 * @returns {Promise<Blob>}
 */
export async function exportImage({ bitmap, width, height, rects, fill, type = 'image/jpeg', quality = 0.92 }) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  paint(ctx, rects, 1, fill)
  return await canvasToBlob(canvas, type, quality)
}
