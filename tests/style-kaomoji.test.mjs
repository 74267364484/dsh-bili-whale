import test from 'node:test'
import assert from 'node:assert/strict'
import { checkStyle, findKaomoji, KAOMOJI_SET } from '../tools/lib/style-guard.mjs'

const has = (res, re) => res.errors.some((e) => re.test(e))

test('表情都不带也不算硬伤（2026-11-26 主人改口径：灵活使用、不限数量）', () => {
  const none = checkStyle('@某人 这段字幕把笑声剪进鼓点里，挺会玩')
  assert.equal(none.errors.length, 0)
  assert.equal(none.stats.kaomoji, 0)

  const one = checkStyle('@某人 这段字幕把笑声剪进鼓点里，挺会玩(:з」∠)')
  assert.equal(one.errors.length, 0)
  assert.equal(one.stats.kaomoji, 1)

  const many = checkStyle('@某人 这段字幕把笑声剪进鼓点里，挺会玩(:з」∠)(=^･ω･^=)(๑•̀ㅂ•́)و✧')
  assert.equal(many.errors.length, 0, '多个表情也必须放行')
  assert.equal(many.stats.kaomoji, 3)
})

test('回复某人（reply）与顶层评论同规则', () => {
  assert.equal(checkStyle('这句我也注意到了', { kind: 'reply' }).errors.length, 0)
  assert.equal(checkStyle('这句我也注意到了(๑• . •๑)', { kind: 'reply' }).errors.length, 0)
})

test('弹幕不受表情条数限制', () => {
  assert.equal(checkStyle('好耶这段鼓点绝了', { kind: 'danmaku' }).errors.length, 0)
  assert.equal(checkStyle('好耶(๑•̀ㅂ•́)و✧(=^･ω･^=)', { kind: 'danmaku' }).errors.length, 0)
})

test('私信不受表情条数限制', () => {
  const res = checkStyle('老大，今晚看了三条，都记在日记里了(:з」∠)(=^･ω･^=)', { kind: 'dm' })
  assert.equal(res.errors.length, 0)
})

test('@ 前缀里的括号不会被误判成颜文字', () => {
  const spans = findKaomoji('@(某某人) 这段转场太顺了')
  assert.equal(spans.length, 0)
})

test('泛化括号颜文字也能识别（白名单之外的老写法）', () => {
  assert.equal(findKaomoji('笑死(￣▽￣)').length, 1)
  assert.equal(findKaomoji('好耶ʕ•ᴥ•ʔ').length, 1)
})

test('原有硬伤规则不变：禁句 / 老大 / 结尾句号', () => {
  assert.ok(has(checkStyle('@某人 太棒了这剪辑(:з」∠)'), /禁句/))
  assert.ok(has(checkStyle('@某人 老大这段剪得好(:з」∠)'), /老大/))
  assert.ok(has(checkStyle('@某人 这段剪得好(:з」∠)。'), /句号/))
})

test('常用颜文字清单与 persona 保持一致', () => {
  assert.equal(KAOMOJI_SET.length, 6)
})
