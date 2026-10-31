// 对外发言（评论区 / 弹幕）的语言规范校验 —— 2026-10-31 主人定
//   动机（主人原话「没有遵循语言规范」）：规范只写在 persona.md 里，提示里也没有复述，
//   于是她写出来的是"太棒了/干货满满/学到了"、公开喊「老大」、结尾带句号、三段小作文。
//   → 这里把它变成**代码层硬约束**：不通过就不发（--force 可放行）。
//   规范出处：~/.bili-ai/persona.md「说话方式 · 对外」+「禁句」+「硬禁止」。

// 禁句（persona.md 第 29 行）—— 出现即拒发
const BANNED = [
  '太棒了', '干货满满', '学到了', '受益匪浅',
  '作为一个AI', '作为AI', '作为 ai', '作为一个 ai', '作为一个AI助手',
  '我是小Z', '我是小z', '我是小 Z',
  '我是AI', '我是ai', '我是 AI', '我是人工智能', '人工智能助手', '语言模型', '大语言模型',
]

// 「首先…其次…最后」这类三段式 —— 单出现「最后」不报（可能是"最后那句"）
const SEQ_OPENERS = ['首先', '其次']

// 公开场合不能提"设置/指令/提示词" —— 只提醒，不拦
const META_WORDS = ['设置', '指令', '提示词', '参数', '后台', '配置项']

// 语气助词（persona.md 对外上限 1 个）
const PARTICLES = ['哦', '呐', '呀', '哟', '哒', '嘛']

// 已知颜文字（persona.md 对内那 6 个）+ 泛化兜底
const KNOWN_KAOMOJI = [
  'ღゝ◡╹)ノ♡', '(´,,•ω•,,)♡', '(๑• . •๑)', '(:з」∠)', '(=^･ω･^=)', '(๑•̀ㅂ•́)و✧',
]
const KAOMOJI_RE = /[(（][^()（）\n]{0,20}[ωღ♡♥ლzﾟ◡╹๑][^()（）\n]{0,8}[)）]?/g

function countKaomoji(text) {
  let n = 0
  for (const k of KNOWN_KAOMOJI) n += text.split(k).length - 1
  const generic = text.match(KAOMOJI_RE) || []
  for (const g of generic) if (!KNOWN_KAOMOJI.some((k) => g.includes(k))) n += 1
  return n
}

function countParticles(text) {
  let n = 0
  for (const p of PARTICLES) n += text.split(p).length - 1
  return n
}

/**
 * @param {string} text  最终要发出去的正文（含自动补的 @ 开头）
 * @returns {{errors:string[], warns:string[], stats:object}}
 */
export function checkStyle(text) {
  const t = String(text ?? '')
  const body = t.replace(/@[^\s@]+\s*/, '').trim()   // 去掉 @主人 前缀再看内容
  const errors = []
  const warns = []

  for (const b of BANNED) {
    if (t.includes(b)) errors.push(`禁句「${b}」—— persona 禁句表里明确不许出现`)
  }
  if (SEQ_OPENERS.some((w) => t.includes(w))) {
    errors.push('「首先…其次…最后」三段式 —— persona 禁用，结论直接说')
  } else if (t.includes('最后') && (t.includes('然后') || t.includes('接着'))) {
    errors.push('「最后…」三段式 —— persona 禁用，结论直接说')
  }
  if (t.includes('老大')) errors.push('公开场合不许叫「老大」—— 对外只能用主人昵称或"你"')
  if (/[。.]\s*$/.test(t)) errors.push('结尾不能带句号 —— B 站人打字不带句号')

  const k = countKaomoji(t)
  if (k > 1) errors.push(`颜文字 ${k} 个，外对上限 1 个`)

  const p = countParticles(body)
  if (p > 1) warns.push(`语气助词 ${p} 个，外对上限 1 个`)

  if (body.length < 10) warns.push(`正文只有 ${body.length} 字，太短 —— 必须写出一个具体细节（某句话/某个梗/某个时间点）`)
  if (body.length > 120) warns.push(`正文 ${body.length} 字，太长 —— 能一句说完就绝不写两句`)

  for (const w of META_WORDS) {
    if (body.includes(w)) warns.push(`提到了「${w}」—— 公开场合不提后台那套`)
  }

  return { errors, warns, stats: { chars: body.length, kaomoji: k, particles: p } }
}

/** 打印校验报告（comment.mjs / dm.mjs 共用） */
export function reportStyle(res, label = '[对外规范]') {
  const out = []
  if (res.errors.length) out.push(`${label} ✗ 不合格（${res.errors.length} 条硬伤，**这条不能发**）`)
  for (const e of res.errors) out.push(`   · ${e}`)
  if (res.warns.length) {
    out.push(`${label} ⚠ 提醒（${res.warns.length} 条）`)
    for (const w of res.warns) out.push(`   · ${w}`)
  }
  if (!res.errors.length && !res.warns.length) out.push(`${label} ✓ 合格（${res.stats.chars} 字 / 颜文字 ${res.stats.kaomoji} / 语气助词 ${res.stats.particles}）`)
  return out.join('\n')
}
