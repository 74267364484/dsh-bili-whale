// 分享策略闸（2026-10-28 改造）
//
// 2026-10-28 主人定：「每看一个视频就要评论，可以不艾特我，不要有数量限制」。
//   → ① rank 必须 === 1 的限制解除（每条都发，不只第一名）
//   → ② 评分阈值 minScore 解除（不必打分才发）
//   → ③ reason ≥8 字解除（不必解释理由）
//   仍然保留的：**必须有 --auto**（防止这条命令被当成主人授权的发言）与 share.enabled 开关。
export function validateShare(cfg, { reason, score, rank = 1 }) {
  if (cfg.share?.enabled === false) throw new Error('分享已关闭（share.enabled=false）')
  // 评分：仍然要求给出（0–20），但**不再设阈值** —— 分数只是给主人看的记录 ✓
  const n = Number(score)
  if (score === undefined || score === '' || typeof score === 'boolean' || !Number.isFinite(n) || n < 0 || n > 20)
    throw new Error('分享需要 --score（0–20）')
  const rankNum = Number(rank)
  if (!Number.isFinite(rankNum) || rankNum < 1) throw new Error('分享需要 --rank（≥1）')
  return {
    score: n,
    reason: typeof reason === 'string' ? reason.trim() : '',
    rank: rankNum,
  }
}
