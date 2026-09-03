/**
 * 当前批次。只在内存里：刷新页面就没了，不写 localStorage，不落磁盘，更不上传。
 * 每个文件带自己的页信息和每页的框。
 */

let job = null
let seq = 0

/** @param files [{name, type:'image'|'pdf', size, blob}] */
export function create(files) {
  job = {
    createdAt: Date.now(),
    files: files.map(f => ({
      id: 'f' + (++seq),
      name: f.name,
      type: f.type,
      size: f.size,
      blob: f.blob,
      // 坐标空间：图片是自然像素，PDF 是页点（1/72 英寸）。框一律存这个空间，
      // 与屏幕缩放无关，出多大分辨率的件都不会偏。
      pages: [],          // [{index, w, h, hasText}]
      pageRects: {},      // {页序号: [框]}
      loaded: false,
      pdf: null,          // {doc, bytes}
      reviewed: false,
      skipped: false,
      status: 'pending',  // pending | reviewed | done | error
      error: '',
      output: null,       // {blob, name, leaks}
      autoDetected: {}    // {页序号: true}，同一页不重复跑识别
    }))
  }
  return job
}

export function current() { return job }
export function reset() { job = null }

export function file(id) {
  return job ? job.files.find(f => f.id === id) || null : null
}

export function counts() {
  if (!job) return { total: 0, reviewed: 0, done: 0, unreviewed: 0 }
  const total = job.files.length
  const reviewed = job.files.filter(f => f.reviewed).length
  const done = job.files.filter(f => f.status === 'done').length
  return { total, reviewed, done, unreviewed: total - reviewed }
}

/** 审完一个文件后跳到下一个没审的，没有就返回 null */
export function nextUnreviewed(afterId) {
  if (!job) return null
  const i = job.files.findIndex(f => f.id === afterId)
  const rest = job.files.slice(i + 1).concat(job.files.slice(0, Math.max(0, i)))
  return rest.find(f => !f.reviewed) || null
}

/** 某个文件一共有多少处将被盖住 */
export function acceptedCount(f) {
  return Object.keys(f.pageRects)
    .reduce((n, k) => n + f.pageRects[k].filter(b => b.accepted).length, 0)
}
