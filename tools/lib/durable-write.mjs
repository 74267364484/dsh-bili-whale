// 2026-11-26：崩溃/断电会把刚写的状态文件落成**全 NUL**（NTFS 分配了簇但数据没刷盘）。
//   实测 11-10 那次同时写坏了 traffic-state.json 与 dm-await-state.json，
//   两份都没有可用备份 → 整条鱼"保护暂停"了 16 天（主人 11-26 才发现「看不到她了」）。
//
// 这里的解法分两层：
//   ① 写：临时文件 → fsync（Windows = FlushFileBuffers）→ rename → 再 fsync 目录，
//      把"文件存在但内容全 0"的窗口压到最小；
//   ② 读：主文件坏了读 .bak，两份都坏 → **隔离坏文件并从空状态自愈**，
//      绝不再用"永久暂停"把整条鱼卡死（那才是这次 16 天静默的直接原因）。
import fs from 'node:fs'
import path from 'node:path'

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/** 落盘写：先 fsync 临时文件再 rename，最后 fsync 目录项（Windows 上失败可忽略） */
export function writeDurable(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'w')
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
  try {
    fs.renameSync(temp, file)
  } finally {
    try { fs.rmSync(temp, { force: true }) } catch {}
  }
  try {
    const dir = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } catch {}
}

/** 同时写主文件与 .bak（备份也走 fsync，避免"主备一起全 NUL"） */
export function writeWithBackup(file, data) {
  writeDurable(file + '.bak', data)
  writeDurable(file, data)
}

/** 把坏文件改名留档，返回隔离后的路径（失败返回 null） */
export function quarantine(file) {
  try {
    const dest = `${file}.corrupt-${stamp()}`
    fs.renameSync(file, dest)
    return dest
  } catch { return null }
}

/**
 * 读一个 JSON 状态文件，坏了就自愈：
 *   主文件 OK        → { state, source: 'main' }
 *   主文件 ENOENT     → { state: {}, source: 'none' }   （调用方按"首次"处理）
 *   主文件坏 + .bak 好 → { state, source: 'bak', recovered: true }
 *   两份都坏          → 隔离两份，{ state: {}, source: 'reset', recovered: true }
 *
 * @param {string} file
 * @param {(s:any)=>boolean} [valid] 额外校验（默认只要是非数组对象）
 */
export function readJsonState(file, valid = (s) => s && typeof s === 'object' && !Array.isArray(s)) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!valid(state)) throw new Error('invalid state')
    return { state, source: 'main' }
  } catch (e) {
    if (e.code === 'ENOENT') return { state: {}, source: 'none' }
  }
  try {
    const state = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'))
    if (!valid(state)) throw new Error('invalid bak')
    return { state, source: 'bak', recovered: true }
  } catch {}
  const a = quarantine(file), b = quarantine(file + '.bak')
  return { state: {}, source: 'reset', recovered: true, quarantined: [a, b].filter(Boolean) }
}
