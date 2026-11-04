import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULTS,
  apply,
  estimateTokens,
  fitContent,
  installResultBudget,
  resolveBudget,
  resolveConfig,
} from '../index.js'

test('budget scales with the context window', () => {
  assert.equal(resolveBudget(4096, 1024, DEFAULTS), 461)
  assert.equal(resolveBudget(8192, 2048, DEFAULTS), 922)
  assert.equal(resolveBudget(32768, 4096, DEFAULTS), 4301)
  assert.equal(resolveBudget(131072, 8192, DEFAULTS), 8000)
})

test('budget floors and fallbacks', () => {
  assert.equal(resolveBudget(2048, 2048, DEFAULTS), 384, 'reservation eating the window still leaves the floor')
  assert.equal(resolveBudget(undefined, 0, DEFAULTS), 2000)
  assert.equal(resolveBudget(0, 0, DEFAULTS), 2000)
})

test('token estimate: latin 4 chars/token, CJK 1 char/token', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('한국어'), 3)
})

test('content within budget is left alone', () => {
  assert.equal(fitContent([{ type: 'text', text: 'hello' }], 100, 'bash'), undefined)
  assert.equal(fitContent(undefined, 100, 'bash'), undefined)
})

test('oversized text keeps head and tail and stays within budget', () => {
  const text = 'L'.repeat(20000) + 'END_MARK'
  const [out, image] = fitContent([{ type: 'text', text }, { type: 'image', url: 'x' }], 500, 'read')
  assert.ok(estimateTokens(out.text) <= 520, String(estimateTokens(out.text)))
  assert.ok(out.text.startsWith('LLLL'))
  assert.ok(out.text.endsWith('END_MARK'))
  assert.match(out.text, /offset\/limit/)
  assert.deepEqual(image, { type: 'image', url: 'x' })
})

test('CJK output is not underestimated', () => {
  const [out] = fitContent([{ type: 'text', text: '错'.repeat(5000) }], 400, 'bash')
  assert.ok(estimateTokens(out.text) <= 420, String(estimateTokens(out.text)))
  assert.match(out.text, /grep, head, tail/)
})

test('multiple text blocks share one budget in order', () => {
  const out = fitContent(
    [
      { type: 'text', text: 'a'.repeat(400) },
      { type: 'text', text: 'b'.repeat(4000) },
      { type: 'text', text: 'c'.repeat(4000) },
    ],
    300,
    'x',
  )
  assert.equal(out[0].text, 'a'.repeat(400))
  assert.match(out[1].text, /omitted/)
  assert.match(out[2].text, /omitted/)
  const total = out.reduce((n, b) => n + estimateTokens(b.text), 0)
  assert.ok(total <= 300 + 3 * 48, String(total))
})

test('config validation fails loud', () => {
  assert.throws(() => resolveConfig({ ratio: 0 }), /ratio/)
  assert.throws(() => resolveConfig({ ratio: 2 }), /ratio/)
  assert.throws(() => resolveConfig({ minTokens: 9000 }), /exceeds/)
  assert.throws(() => resolveConfig({ maxTokens: 1.5 }), /positive integer/)
  assert.throws(() => resolveConfig({ typo: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ exclude: 'bash' }), /exclude/)
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS })
})

function harness(info) {
  let listener
  const ctx = {
    on: (event, fn) => {
      assert.equal(event, 'tools/post-execute')
      listener = fn
      return () => {}
    },
    llm: {
      calls: 0,
      async resolveModelInfo(provider, model) {
        this.calls++
        if (info instanceof Error) throw info
        return info
      },
    },
    logger: { warn() {} },
  }
  return { ctx, run: (...args) => listener(...args) }
}

const agent = (model = 'any') => ({
  session: { requestHeader: () => ({ config: { provider: 'local', model } }) },
})
const big = { content: [{ type: 'text', text: 'x'.repeat(40000) }] }
const accept = async () => ({ kind: 'accept' })

test('post-execute: trims to the routed model window and caches model info', async () => {
  const { ctx, run } = harness({ context: { contextWindow: 8192 }, defaultMaxTokens: 2048 })
  apply(ctx, {})
  const d = await run({ agent: agent(), name: 'bash' }, big, accept)
  assert.equal(d.kind, 'accept')
  const t = estimateTokens(d.content[0].text)
  assert.ok(t > 800 && t <= 930, String(t))
  await run({ agent: agent(), name: 'bash' }, big, accept)
  assert.equal(ctx.llm.calls, 1)
})

test('post-execute: request maxTokens overrides the model default reservation', async () => {
  const { ctx, run } = harness({ context: { contextWindow: 8192 }, defaultMaxTokens: 2048 })
  installResultBudget(ctx)
  const a = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 0 } }) } }
  const d = await run({ agent: a, name: 'bash' }, big, accept)
  const t = estimateTokens(d.content[0].text)
  assert.ok(t > 1150 && t <= 1230, String(t)) // 0.15 × 8192 ≈ 1229
})

test('post-execute: unknown window or lookup failure uses fallback', async () => {
  const { ctx, run } = harness(new Error('offline'))
  installResultBudget(ctx, { fallbackTokens: 500 })
  const d = await run({ agent: agent(), name: 'bash' }, big, accept)
  assert.ok(estimateTokens(d.content[0].text) <= 500)
  const noAgent = await run({ name: 'bash' }, big, accept)
  assert.ok(estimateTokens(noAgent.content[0].text) <= 500)
})

test('post-execute: leaves blocks, values, small and excluded results alone', async () => {
  const { ctx, run } = harness({ context: { contextWindow: 4096 } })
  installResultBudget(ctx, { exclude: ['mcp_*'] })
  const blocked = { kind: 'block', feedback: [] }
  assert.equal(await run({ agent: agent(), name: 'bash' }, big, async () => blocked), blocked)
  const valued = { kind: 'accept', value: { ok: true } }
  assert.equal(await run({ agent: agent(), name: 'bash' }, big, async () => valued), valued)
  const small = { kind: 'accept' }
  assert.equal(await run({ agent: agent(), name: 'bash' }, { content: [{ type: 'text', text: 'ok' }] }, async () => small), small)
  const ex = { kind: 'accept' }
  assert.equal(await run({ agent: agent(), name: 'mcp_github_search' }, big, async () => ex), ex)
})

test('post-execute: trims replacement content from an earlier listener and keeps its extras', async () => {
  const { ctx, run } = harness({ context: { contextWindow: 4096 } })
  installResultBudget(ctx)
  const extra = [{ role: 'user' }]
  const d = await run({ agent: agent(), name: 'web_fetch' }, { content: [] }, async () => ({
    kind: 'accept',
    content: [{ type: 'text', text: 'y'.repeat(30000) }],
    additionalContexts: extra,
  }))
  assert.match(d.content[0].text, /Narrow the request/)
  assert.equal(d.additionalContexts, extra)
})
