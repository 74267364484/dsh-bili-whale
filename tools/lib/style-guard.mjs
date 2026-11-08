// 对外发言（评论区 / 弹幕 / 私信）的语言规范校验 —— 2026-10-31 主人定，2026-11-08 补「评论必须带颜文字」
//   动机（主人原话「没有遵循语言规范」）：规范只写在 persona.md 里，提示里也没有复述，
//   于是她写出来的是"太棒了/干货满满/学到了"、公开喊「老大」、结尾带句号、三段小作文。
//   → 这里把它变成**代码层硬约束**：不通过就不发（--force 可放行）。
//
// 2026-11-08 主人原话「机器人没有遵循用颜文字评论的规则」：
//   原来的校验只有**上限**（颜文字最多 1 个），没有**下限** —— 一条都不带也照样放行，
//   于是公开评论经常一个颜文字都没有 ✗。现在按场合分开判：
//     · comment / reply（公开评论）→ **必须恰好 1 个**：0 个算硬伤，2 个以上也算硬伤
//     · danmaku（弹幕）→ 0 或 1 个都可以（persona 原话「弹幕可以完全不用」）
//     · dm（对内私信）→ 不受此限（对内可以多用）
//   同时把颜文字识别做稳：白名单精确匹配 + 括号型泛化 + ʕ…ʔ 型，避免误把「(@主人)」算成颜文字。
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

// 对外可用的颜文字（persona.md 对内那 6 个；对外也从这 6 个里挑，保持人设一致）
export const KAOMOJI_SET = [
  'ღゝ◡╹)ノ♡',
  '(´,,•ω•,,)♡',
  '(๑• . •๑)',
  '(:з」∠)',
  '(=^･ω･^=)',
  '(๑•̀ㅂ•́)و✧',
]

// 颜文字特征字符 —— 括号里出现这些，才算颜文字（避免把「(@主人)」「(转)」算进去）
const KAOMOJI_FEATURE = /[ω◡╹ʕʔᴥ≧≦￣▽°□•˘๑ฅლღ♡♥ノヽ彡✧｡ﾟ︿皿ㅂ﹏ᐛᕕᕗ◕ᴗ]/u

/**
 * 找出文本里所有颜文字的位置区间（不重叠，长的优先）
 * @param {string} text
 * @returns {{start:number,end:number,text:string}[]}
 */
export function findKaomoji(text) {
  const spans = []
  const push = (s, e, t) => {
    if (e <= s) return
    // 与已有区间重叠 → 跳过（白名单先入，所以精确形态优先）
    if (spans.some((x) => s < x.end && x.start < e)) return
    spans.push({ start: s, end: e, text: t })
  }

  // ① 白名单精确匹配
  for (const k of KAOMOJI_SET) {
    let i = text.indexOf(k)
    while (i !== -1) {
      push(i, i + k.length, k)
      i = text.indexOf(k, i + 1)
    }
  }

  // ② 括号型泛化：() / （）里 1–14 个字符，且含颜文字特征字符
  const parenRe = /[(（]([^()（）\n]{1,14})[)）]/gu
  for (const m of text.matchAll(parenRe)) {
    if (KAOMOJI_FEATURE.test(m[1])) push(m.index, m.index + m[0].length, m[0])
  }

  // ③ 熊爪型 ʕ•ᴥ•ʔ 这类不用括号的
  const bearRe = /ʕ[^ʕʔ\n]{0,12}ʔ/gu
  for (const m of text.matchAll(bearRe)) push(m.index, m.index + m[0].length, m[0])

  return spans.sort((a, b) => a.start - b.start)
}

function countKaomoji(text) {
  return findKaomoji(text).length
}

function countParticles(text) {
  let n = 0
  for (const p of PARTICLES) n += text.split(p).length - 1
  return n
}

/**
 * @param {string} text  最终要发出去的正文（含自动补的 @ 开头）
 * @param {{kind?: 'comment'|'reply'|'danmaku'|'dm'}} [opts]
 *        comment/reply = 公开评论（必须恰好 1 个颜文字）
 *        danmaku       = 弹幕（0 或 1 个都可以）
 *        dm            = 对内私信（不限）
 * @returns {{errors:string[], warns:string[], stats:object}}
 */
export function checkStyle(text, opts = {}) {
  const t = String(text ?? '')
  const kind = opts.kind ?? 'comment'
  // 公开场合（评论 / 回复 / 弹幕）才受"禁句、不许叫老大、三段式"约束；对内私信可以叫老大
  const publicSpeech = kind !== 'dm'
  // 只有公开评论要求"必须恰好 1 个颜文字"
  const kaomojiRequired = kind === 'comment' || kind === 'reply'
  const body = t.replace(/@[^\s@]+\s*/, '').trim()   // 去掉 @主人 前缀再看内容
  const errors = []
  const warns = []

  if (publicSpeech) {
    for (const b of BANNED) {
      if (t.includes(b)) errors.push(`禁句「${b}」—— persona 禁句表里明确不许出现`)
    }
    if (SEQ_OPENERS.some((w) => t.includes(w))) {
      errors.push('「首先…其次…最后」三段式 —— persona 禁用，结论直接说')
    } else if (t.includes('最后') && (t.includes('然后') || t.includes('接着'))) {
      errors.push('「最后…」三段式 —— persona 禁用，结论直接说')
    }
    if (t.includes('老大')) errors.push('公开场合不许叫「老大」—— 对外只能用主人昵称或"你"')
  }
  if (/[。.]\s*$/.test(t)) errors.push('结尾不能带句号 —— B 站人打字不带句号')

  const kaomoji = findKaomoji(t)
  const k = kaomoji.length
  if (kaomojiRequired) {
    // 2026-11-08：公开评论**必须恰好 1 个**颜文字
    if (k === 0) {
      errors.push('评论必须带 1 个颜文字 —— 从这几个里挑一个放句尾：' + KAOMOJI_SET.join(' / '))
    } else if (k > 1) {
      errors.push(`颜文字 ${k} 个（${kaomoji.map((x) => x.text).join(' ')}），对外上限 1 个`)
    }
  } else if (kind === 'danmaku' && k > 1) {
    errors.push(`弹幕颜文字 ${k} 个，最多 1 个`)
  }

  const p = countParticles(body)
  if (p > 1) warns.push(`语气助词 ${p} 个，外对上限 1 个`)

  if (body.length < 10) warns.push(`正文只有 ${body.length} 字，太短 —— 必须写出一个具体细节（某句话/某个梗/某个时间点）`)
  if (body.length > 120) warns.push(`正文 ${body.length} 字，太长 —— 能一句说完就绝不写两句`)

  for (const w of META_WORDS) {
    if (body.includes(w)) warns.push(`提到了「${w}」—— 公开场合不提后台那套`)
  }

  return {
    errors,
    warns,
    stats: { kind, chars: body.length, kaomoji: k, kaomojiList: kaomoji.map((x) => x.text), particles: p },
  }
}

/**
 * 按正文语气挑一个最贴的颜文字（用于"漏写时自动补一个"，2026-11-08）
 * 顺序很重要：先吐槽/负面，再大笑，再夸，再喜欢，最后默认
 */
export function pickKaomoji(text) {
  const t = String(text ?? '')
  if (/(无语|离谱|崩|槽|翻车|可惜|唉|难|累|麻了|看不懂|抽象)/.test(t)) return '(:з」∠)'
  if (/(笑死|太好笑|哈哈|乐死|绷不住|笑不活)/.test(t)) return '(=^･ω･^=)'
  if (/(绝|牛|帅|厉害|真棒|好看|好爱|冲|加油|稳|神|顶|强)/.test(t)) return '(๑•̀ㅂ•́)و✧'
  if (/(好想|喜欢|爱|心动|暖|甜|治愈)/.test(t)) return '(´,,•ω•,,)♡'
  return '(๑• . •๑)'
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
  if (!res.errors.length && !res.warns.length) {
    out.push(`${label} ✓ 合格（${res.stats.chars} 字 / 颜文字 ${res.stats.kaomoji} / 语气助词 ${res.stats.particles}）`)
  }
  return out.join('\n')
}
