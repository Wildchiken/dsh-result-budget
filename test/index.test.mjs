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
  assert.equal(resolveBudget(131072, 8192, DEFAULTS), 18432)
  assert.equal(resolveBudget(1048576, 8192, DEFAULTS), 156058, 'large windows are not capped by default')
  assert.equal(resolveBudget(131072, 8192, { ...DEFAULTS, maxTokens: 8000 }), 8000, 'an explicit cap still applies')
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
  const [out, image] = fitContent([{ type: 'text', text }, { type: 'image', url: 'x' }], 500, 'bash')
  assert.ok(estimateTokens(out.text) <= 520, String(estimateTokens(out.text)))
  assert.ok(out.text.startsWith('LLLL'))
  assert.ok(out.text.endsWith('END_MARK'))
  assert.deepEqual(image, { type: 'image', url: 'x' })
})

// Same shape as the real dsh-tool-fs read output.
function readOutput(from, to, next) {
  const lines = []
  for (let n = from; n <= to; n++) lines.push(`${n}: line ${String(n).padStart(5, '0')} the quick brown fox jumps over the lazy dog`)
  return `<path>/w/f.txt</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n(Showing lines ${from}-${to} of 3000. Use offset=${next} to continue.)\n</content>`
}

test('read: paging from the notice covers every line, with no hole', () => {
  // Page through lines 1-930 the way a model would: follow each offset the result names.
  const seen = new Set()
  let offset = 1
  for (let page = 0; page < 50 && offset <= 930; page++) {
    // The last page fits, so fitContent leaves it unchanged (returns undefined).
    const content = [{ type: 'text', text: readOutput(offset, 930, 931) }]
    const [out] = fitContent(content, 1000, 'read') ?? content
    assert.ok(estimateTokens(out.text) <= 1000, String(estimateTokens(out.text)))
    for (const m of out.text.matchAll(/^(\d+): /gm)) seen.add(Number(m[1]))
    const next = /offset=(\d+)/.exec(out.text)
    assert.ok(next, 'names where to continue')
    assert.ok(Number(next[1]) > offset, 'always makes progress')
    offset = Number(next[1])
  }
  for (let n = 1; n <= 930; n++) assert.ok(seen.has(n), `line ${n} was skipped`)
})

test('read: keeps only complete lines and no stale footer', () => {
  const [out] = fitContent([{ type: 'text', text: readOutput(1, 930, 931) }], 1000, 'read')
  assert.ok(!out.text.includes('offset=931'), 'stale footer must not survive')
  assert.ok(out.text.endsWith('</content>'))
  const last = [...out.text.matchAll(/^(\d+): (.*)$/gm)].at(-1)
  assert.match(last[2], /lazy dog$/)
  assert.match(out.text, new RegExp(`offset=${Number(last[1]) + 1}\\b`))
})

test('read: a single line too long for the budget still says what to do', () => {
  const text = `<path>/w/f</path>\n<type>file</type>\n<content>\n1: ${'x'.repeat(20000)}\n</content>`
  const [out] = fitContent([{ type: 'text', text }], 400, 'read')
  assert.ok(estimateTokens(out.text) <= 400, String(estimateTokens(out.text)))
  assert.match(out.text, /grep/)
  assert.ok(!/offset=\d/.test(out.text), 'must not send the model back to the same line')
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
  assert.throws(() => resolveConfig({ minTokens: 9000, maxTokens: 8000 }), /exceeds/)
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
