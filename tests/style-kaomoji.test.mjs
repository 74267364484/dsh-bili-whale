import test from 'node:test'
import assert from 'node:assert/strict'
import { checkStyle, findKaomoji, pickKaomoji, KAOMOJI_SET } from '../tools/lib/style-guard.mjs'

const has = (res, re) => res.errors.some((e) => re.test(e))

test('公开评论必须恰好带 1 个颜文字（2026-11-08 主人定）', () => {
  const none = checkStyle('@某人 这段字幕把笑声剪进鼓点里，挺会玩')
  assert.ok(has(none, /必须带 1 个颜文字/), '不带颜文字必须报硬伤')

  const one = checkStyle('@某人 这段字幕把笑声剪进鼓点里，挺会玩(:з」∠)')
  assert.equal(one.errors.length, 0, '带 1 个白名单颜文字应通过')
  assert.equal(one.stats.kaomoji, 1)

  const two = checkStyle('@某人 这段字幕把笑声剪进鼓点里，挺会玩(:з」∠)(=^･ω･^=)')
  assert.ok(has(two, /颜文字 2 个/), '两个颜文字必须报硬伤')
})

test('回复某人（reply）与顶层评论同规则', () => {
  assert.ok(has(checkStyle('这句我也注意到了', { kind: 'reply' }), /必须带 1 个颜文字/))
  assert.equal(checkStyle('这句我也注意到了(๑• . •๑)', { kind: 'reply' }).errors.length, 0)
})

test('弹幕可以完全不用颜文字，但最多 1 个', () => {
  assert.equal(checkStyle('好耶这段鼓点绝了', { kind: 'danmaku' }).errors.length, 0)
  assert.ok(has(checkStyle('好耶(๑•̀ㅂ•́)و✧(=^･ω･^=)', { kind: 'danmaku' }), /弹幕颜文字 2 个/))
})

test('私信不受颜文字条数限制', () => {
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

test('白名单与 persona 保持一致', () => {
  assert.equal(KAOMOJI_SET.length, 6)
})

test('漏写颜文字时自动补一个，且补完恰好 1 个', () => {
  assert.equal(pickKaomoji('结局有点离谱'), '(:з」∠)')
  assert.equal(pickKaomoji('笑死我了'), '(=^･ω･^=)')
  assert.equal(pickKaomoji('这段转场真绝'), '(๑•̀ㅂ•́)و✧')
  assert.equal(pickKaomoji('看完心里暖暖的'), '(´,,•ω•,,)♡')
  assert.equal(pickKaomoji('今天天气'), '(๑• . •๑)')

  const filled = '今天天气' + pickKaomoji('今天天气')
  assert.equal(checkStyle(filled).errors.length, 0, '自动补完应能通过')
  assert.equal(findKaomoji(filled).length, 1)
})
