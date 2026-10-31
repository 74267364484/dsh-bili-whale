// 视频情报采集（2026-10-28 新增）—— 补上「原版能获取的信息太少」这个洞
//
// 背景：原版 debrief 只有六路（元信息/封面/官方字幕/弹幕/热评/抽帧），
//   而且热评接口 `x/v2/reply?sort=2` 只给 6 条、标签/章节/相关推荐/UP 影响力全都没取。
//   实测后（2026-10-28）新增下面这些**全都经得起真实验证**的信息源：
//
//   ① B站 AI 字幕（ai-zh / ai-en / …）—— 覆盖率 93%（30 个热门视频里 28 个有）
//      这是最关键的一条：B站 自带的 ASR，**不要钱、不要 NVIDIA、毫秒级返回**，
//      比自己抽音轨送模型强（NVIDIA 的 nemotron omni 实测拒绝音频输入，返回 NO_AUDIO）。
//      字幕带 from/to 时间轴 → 能把弹幕/评论精确对到画面上。
//   ② 官方 AI 总结 `view/conclusion/get` —— 必须 WBI 签名（不签 -403）。
//      给 summary（整体讲了什么）+ outline（章节）+ subtitle（带时间轴的口播）。
//   ③ 新版评论 `x/v2/reply/main` —— **无需签名**，热评/最新两种模式，
//      32 个字段（含 IP 属地、是否 UP 主、二级评论），cursor 可分页。
//   ④ `x/v2/reply/reply` —— 二级评论（观众之间的对话往往比主楼更有信息量）。
//   ⑤ `x/web-interface/view/detail` —— 一次拿全 标签 + 联合出品方 + 相关推荐。
//   ⑥ `x/space/upstat` + `x/relation/stat` —— UP 总播放/获赞/粉丝量（判断作者分量）。
//   ⑦ `x/player/wbi/v2` 的 view_points —— 真实章节（起止秒 + 封面）。
//
// 已实测失效、不要用的：x/web-interface/archive/stat（404）、archive/detail（404）、
//   x/vup/display（404）、x/article/viewinfo（要真 cvid）。
import { guardedFetch as fetch } from './traffic.mjs'
import { apiGet } from './bili-api.mjs'
import zlib from 'node:zlib'

const API = 'https://api.bilibili.com'

/** 从 view.data 里拿 aid/cid/owner，缺一不可。 */
export function basicsOf(viewData) {
  const d = viewData ?? {}
  return {
    aid: d.aid,
    cid: d.cid,
    mid: d.owner?.mid,
    upName: d.owner?.name,
    duration: d.duration,
    title: d.title,
  }
}

/**
 * ① B站 AI 字幕（+ 官方字幕）
 * @returns {{tracks:Array, best:object|null, body:Array, kind:'ai'|'user'|'none'}}
 */
export async function fetchSubtitles(viewData, headers, { prefer = 'ai' } = {}) {
  const d = viewData ?? {}
  const tracks = []
  const tryTracks = async (url) => {
    const r = await apiGet(url, headers)
    return r?.data?.subtitle?.subtitles ?? []
  }
  try {
    tracks.push(...(await tryTracks(`${API}/x/player/wbi/v2?bvid=${d.bvid}&cid=${d.cid}`)))
  } catch {}
  if (!tracks.length) {
    try { tracks.push(...(await tryTracks(`${API}/x/player/v2?bvid=${d.bvid}&cid=${d.cid}`))) } catch {}
  }
  if (!tracks.length) return { tracks: [], best: null, body: [], kind: 'none' }

  // 排序：AI 原声（type=1, ai_type=0）> AI 翻译 > 用户上传 > 其它语种
  const score = (s) => {
    const lan = String(s.lan ?? '')
    const isAi = lan.startsWith('ai-')
    const isZh = lan === 'ai-zh' || lan === 'zh-CN' || lan === 'zh-Hans'
    const isTrans = Number(s.ai_type) === 1
    let v = 0
    if (isAi) v += 10
    if (isZh) v += 20
    if (Number(s.ai_type) === 0) v += 3
    if (isTrans) v -= 2
    if (Number(s.type) === 1) v += 1
    return v
  }
  const usable = tracks.filter(s => s.subtitle_url && Number(s.ai_status ?? 2) === 2)
  const pool = usable.length ? usable : tracks.filter(s => s.subtitle_url)
  const best = pool.slice().sort((a, b) => score(b) - score(a))[0] ?? null
  let body = []
  if (best) {
    const url = String(best.subtitle_url).startsWith('http') ? best.subtitle_url : 'https:' + best.subtitle_url
    try {
      const r = await fetch(url, { headers })
      if (r.ok) {
        const t = await r.text()
        try { body = JSON.parse(t).body ?? [] } catch {}
      }
    } catch {}
  }
  const kind = String(best?.lan ?? '').startsWith('ai-') ? 'ai' : (best ? 'user' : 'none')
  return { tracks, best, body, kind }
}

/**
 * ② 官方 AI 总结（需 WBI 签名 —— 调用方已有 wbi() 函数）
 */
export async function fetchConclusion(viewData, headers, wbi) {
  const d = viewData ?? {}
  if (!d.bvid || !d.cid) return null
  try {
    const r = await apiGet(`${API}/x/web-interface/view/conclusion/get?${wbi({ bvid: d.bvid, cid: d.cid, up_mid: d.owner?.mid })}`, headers)
    const mr = r?.data?.model_result
    if (!mr) return null
    return {
      summary: String(mr.summary ?? ''),
      outline: Array.isArray(mr.outline) ? mr.outline : [],
      subtitle: Array.isArray(mr.subtitle) ? mr.subtitle : [],
    }
  } catch { return null }
}

/**
 * ③ 新版评论主楼（无需 WBI）
 * @param {'hot'|'new'} mode
 */
export async function fetchReplies(aid, headers, { mode = 'hot', next = 0, ps = 20 } = {}) {
  const m = mode === 'hot' ? 3 : 2
  try {
    const r = await apiGet(`${API}/x/v2/reply/main?type=1&oid=${aid}&mode=${m}&next=${next}&ps=${ps}`, headers)
    if (r?.code !== 0) return { replies: [], cursor: null, code: r?.code }
    const cur = r.data?.cursor ?? null
    return {
      replies: r.data?.replies ?? [],
      top: r.data?.top?.upper ? r.data.top : null,
      // ⚠️ 2026-10-31：cursor 是对象 {next, is_end, all_count}，直接传给 next= 会拼成 [object Object] ✗
      //   → 这里把可用的 next 游标（数字）单独取出来；翻完了（is_end）就返回 null。
      cursor: cur && cur.is_end === false && Number.isFinite(Number(cur.next)) ? Number(cur.next) : null,
      allCount: Number(cur?.all_count ?? 0),
    }
  } catch { return { replies: [], cursor: null, code: -1 } }
}

/** ④ 二级评论（主楼下的对话） */
export async function fetchSubReplies(oid, root, headers, { ps = 10 } = {}) {
  try {
    const r = await apiGet(`${API}/x/v2/reply/reply?type=1&oid=${oid}&root=${root}&ps=${ps}`, headers)
    if (r?.code !== 0) return { replies: [], root: null }
    return { replies: r.data?.replies ?? [], root: r.data?.root ?? null, count: Number(r.data?.page?.count ?? 0) }
  } catch { return { replies: [], root: null } }
}

/** ⑤ 视频详情（标签 + 联合出品方 + 相关推荐） */
export async function fetchViewDetail(bvid, headers) {
  try {
    const r = await apiGet(`${API}/x/web-interface/view/detail?bvid=${bvid}`, headers)
    if (r?.code !== 0) return null
    return {
      tags: (r.data?.Tags ?? []).map(t => ({ name: t.tag_name ?? t.tag ?? '', desc: t.tag?.content ?? '', likes: Number(t.like ?? 0) })),
      staff: (r.data?.View?.staff ?? []).map(s => ({ title: s.title ?? '', name: s.name ?? '', mid: s.mid })),
      related: (r.data?.Related ?? []).slice(0, 12).map(v => ({ bvid: v.bvid, title: v.title, up: v.owner?.name, view: Number(v.stat?.view ?? 0), dur: v.duration, likes: Number(v.stat?.like ?? 0) })),
      hotShare: r.data?.hot_share ?? null,
      viewAddi: r.data?.view_addit ?? null,
    }
  } catch { return null }
}

/** ⑥ UP 主分量：总播放 / 总获赞 / 粉丝数 */
export async function fetchUpStat(mid, headers) {
  const out = { plays: 0, likes: 0, fans: 0 }
  try {
    const u = await apiGet(`${API}/x/space/upstat?mid=${mid}`, headers)
    const st = u?.data?.stat ?? u?.data
    if (st) {
      out.plays = Number(st.archive?.view ?? st.view ?? 0)
      out.likes = Number(st.archive?.like ?? st.likes ?? 0)
    }
  } catch {}
  try {
    const f = await apiGet(`${API}/x/relation/stat?vmid=${mid}`, headers)
    if (f?.code === 0) out.fans = Number(f.data?.follower ?? 0)
  } catch {}
  return out
}

/** ⑦ 章节（view_points）—— 覆盖率低，缺了要降级 */
export async function fetchChapters(viewData, headers) {
  try {
    const r = await apiGet(`${API}/x/player/wbi/v2?bvid=${viewData?.bvid}&cid=${viewData?.cid}`, headers)
    return (r?.data?.view_points ?? []).map(p => ({
      from: Number(p.from ?? 0), to: Number(p.to ?? 0),
      content: String(p.content ?? ''), img: p.imgUrl ?? '',
    }))
  } catch { return [] }
}

/**
 * 弹幕（老 XML 接口）：拿不到就返回空数组。
 * ⚠️ 2026-10-14 实测：该接口返回**不带 content-encoding 头的 deflate 流**，
 *   fetch 不会自动解 → 必须自己试 inflateRaw/inflate/gunzip/brotli。
 */
export async function fetchDanmaku(cid, headers, { referer = 'https://www.bilibili.com/' } = {}) {
  try {
    const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: { ...headers, referer } })
    const buf = Buffer.from(await r.arrayBuffer())
    let xml = buf.toString('utf8')
    if (!xml.includes('<d ') && !xml.includes('<i>')) {
      for (const fn of ['inflateRawSync', 'inflateSync', 'gunzipSync', 'brotliDecompressSync']) {
        try {
          const out = zlib[fn](buf).toString('utf8')
          if (out.includes('<d ') || out.includes('<i>')) { xml = out; break }
        } catch {}
      }
    }
    return [...xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)].map((m) => ({
      t: Number(m[1].split(',')[0]),
      text: m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
    })).filter((x) => Number.isFinite(x.t))
  } catch { return [] }
}

/**
 * 把评论对象压成一行（省 token，但保留有信息量的字段）
 * ⚠️ 2026-10-28 实测修正：`up_action` 是对象 `{like, reply}`，**永远 truthy** ✗
 *   之前用 `r.up_action ? 'UP' : ''` → 所有评论都被标成 UP ✗
 *   UP 主身份只能靠 **mid 与视频作者 mid 比对** ✓
 */
export function replyLine(r, ownerMid = '') {
  const msg = String(r?.content?.message ?? '').replace(/\n+/g, ' ').trim()
  const loc = String(r?.reply_control?.location ?? '').replace(/^IP属地：/, '')
  const mid = String(r?.mid_str ?? r?.mid ?? '')
  const up = ownerMid && mid === String(ownerMid) ? 'UP' : ''
  return {
    rpid: r?.rpid_str ?? r?.rpid,
    like: Number(r?.like ?? 0),
    rcount: Number(r?.rcount ?? 0),
    mid,
    uname: r?.member?.uname ?? '',
    level: Number(r?.member?.level_info?.current_level ?? 0),
    loc, up,
    time: String(r?.reply_control?.time_desc ?? '').replace(/前发布$/, '前'),
    msg,
  }
}
