/**
 * 「要打码的信息」：姓名、单位、简称、身份证号。
 *
 * 存在浏览器的 localStorage 里，只在本机，不随任何请求发出——网页版整条流程都不联网，
 * 这份信息唯一的用途是在 PDF 的文字层里查找它出现在哪些位置。
 * 数据结构与小程序版一致，两版口径不分家。
 */

const KEY = 'msmy.profile'
const SCHEMA_KEY = 'msmy.schema'
const SCHEMA = 1

export function emptyProfile() {
  return { name: '', orgFull: '', orgAlias: [], idNo: '' }
}

export function readProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return emptyProfile()
    const p = Object.assign(emptyProfile(), raw)
    if (!Array.isArray(p.orgAlias)) p.orgAlias = []
    p.orgAlias = p.orgAlias.filter(Boolean)
    return p
  } catch (e) {
    return emptyProfile()
  }
}

export function writeProfile(profile) {
  localStorage.setItem(KEY, JSON.stringify(profile))
  localStorage.setItem(SCHEMA_KEY, String(SCHEMA))
}

export function clearProfile() {
  localStorage.removeItem(KEY)
}

export function isReady(profile) {
  const p = profile || readProfile()
  return Boolean(p.name && p.orgFull)
}

export function categories(profile) {
  const p = profile || readProfile()
  const list = []
  if (p.name) list.push('姓名')
  if (p.orgFull) list.push(p.orgAlias.length ? '单位及简称' : '单位')
  if (p.idNo) list.push('身份证号')
  return list
}

/* ---------- 遮盖颜色 ---------- */

/**
 * 可选的遮盖色。默认黑：最不像"还没打完"，打印出来也最干脆。
 * line 是屏幕上框的边线色——白色块在白纸上没有边线就看不见了。
 */
export const FILLS = [
  { name: '黑', hex: '#000000', line: '#000000' },
  { name: '红', hex: '#e53935', line: '#b71c1c' },
  { name: '橙', hex: '#fb8c00', line: '#e65100' },
  { name: '黄', hex: '#ffd400', line: '#c8a600' },
  { name: '绿', hex: '#43a047', line: '#1b5e20' },
  { name: '青', hex: '#00acc1', line: '#006064' },
  { name: '蓝', hex: '#1e88e5', line: '#0d47a1' },
  { name: '紫', hex: '#8e24aa', line: '#4a148c' },
  { name: '白', hex: '#ffffff', line: '#8a9690' }
]
export const DEFAULT_FILL = FILLS[0].hex
const FILL_KEY = 'msmy.fill'

export function readFill() {
  const v = localStorage.getItem(FILL_KEY)
  return FILLS.some(f => f.hex === v) ? v : DEFAULT_FILL
}

export function writeFill(hex) {
  if (FILLS.some(f => f.hex === hex)) localStorage.setItem(FILL_KEY, hex)
}

export function fillInfo(hex) {
  return FILLS.find(f => f.hex === hex) || FILLS[0]
}

/**
 * 识别用的关键词表。长的排前面：
 * 「安徽省××水利勘测设计院」要先匹配掉，否则简称「××设计院」会先切一刀，
 * 剩下的字露在外面。
 */
export function needles(profile) {
  const p = profile || readProfile()
  const out = []
  if (p.name) out.push({ text: p.name, kind: 'name' })
  if (p.orgFull) out.push({ text: p.orgFull, kind: 'org' })
  p.orgAlias.forEach(a => { if (a) out.push({ text: a, kind: 'org' }) })
  if (p.idNo) out.push({ text: p.idNo, kind: 'idNo' })
  return out.sort((a, b) => b.text.length - a.text.length)
}
