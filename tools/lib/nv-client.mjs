// NVIDIA NIM 直连客户端（2026-10-28 新增）
//
// 为什么需要它：DSH 的 `ctx.llm.stream()` 走的是 agent loop 里的**单次尝试**语义，
// 而本插件有几处必须在**工具脚本内部**发起模型调用（音轨转写、字幕纠错、二次归纳）。
// 那些地方吃不到 dsh-llm-retry 的重试策略，所以自己实现一份。
//
// 主人定的重试语义（2026-10-28）：
//   · 失败（连接失败 / 5xx / 超时）→ 等 5 秒 → 重试
//   · **连续 100 次重试仍然连不上 → 才终止**
//   · 因为用的是英伟达的 API，token 消耗不用在意 → 所以重试预算给得很足
//
// 密钥从 ~/.dsh/.credentials.yaml 的 refs.NV_API_KEY 读（DSH 自己的凭据 seam），
// 读不到再退回环境变量 NV_API_KEY。密钥永不打日志。
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './paths.mjs'

const DEFAULT_BASE = 'https://integrate.api.nvidia.com/v1'
// 2026-10-28 主人定：失败等 5 秒、连续 100 次重试仍失败才终止
export const RETRY_DELAY_MS = 5000
export const MAX_RETRIES = 100

/** 从 DSH 的凭据文件里抠出 refs.<name>（简单 YAML 缩进解析，够用即可） */
function refsFromCredentials() {
  const file = path.join(HOME, '.dsh', '.credentials.yaml')
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return {} }
  const out = {}
  let inRefs = false
  for (const line of raw.split(/\r?\n/)) {
    if (/^refs\s*:/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line) && !/^\s/.test(line)) { inRefs = false; continue }
    if (!inRefs) continue
    const m = /^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

export function apiKey() {
  const fromEnv = process.env.NV_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const v = refsFromCredentials().NV_API_KEY
  return v && String(v).trim() ? String(v).trim() : ''
}

export const baseURL = () => (process.env.NV_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 调一次 NVIDIA chat completions，失败自动重试。
 * @param {object} o
 * @param {string} o.model            模型 id
 * @param {Array}  o.messages         OpenAI 风格 messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {number} [o.timeoutMs]      单次请求超时
 * @param {number} [o.maxRetries]     连续失败上限（默认 100）
 * @param {number} [o.retryDelayMs]   重试间隔（默认 5000）
 * @param {(msg:string)=>void} [o.onRetry]
 * @returns {Promise<{text:string, raw:object, usage:object}>}
 */
export async function chat({
  model,
  messages,
  maxTokens = 2048,
  temperature = 0.4,
  timeoutMs = 300_000,
  maxRetries = MAX_RETRIES,
  retryDelayMs = RETRY_DELAY_MS,
  onRetry,
  signal,
}) {
  const key = apiKey()
  if (!key) throw new Error('找不到 NV_API_KEY（~/.dsh/.credentials.yaml 的 refs.NV_API_KEY 或环境变量）')
  const url = `${baseURL()}/chat/completions`
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (!res.ok) {
        // 4xx（除 408/429）说明请求本身有问题，重试也没用 → 直接抛
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw Object.assign(new Error(`NVIDIA ${res.status}: ${text.slice(0, 300)}`), { fatal: true })
        }
        throw new Error(`NVIDIA ${res.status}: ${text.slice(0, 300)}`)
      }
      let json
      try { json = JSON.parse(text) } catch { throw new Error(`NVIDIA 返回非 JSON：${text.slice(0, 200)}`) }
      const content = json?.choices?.[0]?.message?.content ?? ''
      if (!String(content).trim()) throw new Error('NVIDIA 返回空内容')
      return { text: String(content), raw: json, usage: json?.usage ?? {} }
    } catch (e) {
      if (e?.fatal) throw e
      lastErr = e
      if (attempt >= maxRetries) break
      if (onRetry) {
        try { onRetry(`第 ${attempt + 1}/${maxRetries} 次失败：${String(e?.message ?? e).slice(0, 160)} —— ${retryDelayMs / 1000} 秒后重试`) } catch {}
      }
      await sleep(retryDelayMs)
    }
  }
  throw new Error(`NVIDIA 连不上（重试 ${maxRetries} 次仍失败）：${String(lastErr?.message ?? lastErr).slice(0, 300)}`)
}

/** 把一张本地图片读成 data URI（给 image_url 用） */
export function imageDataUri(file) {
  const buf = fs.readFileSync(file)
  const ext = path.extname(file).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** 把一段 WAV 读成 base64（给 input_audio 用） */
export function audioData(file) {
  return fs.readFileSync(file).toString('base64')
}
