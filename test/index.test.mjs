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

test('token estimate depends on the kind of text', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('한국어'), 3)
  assert.equal(estimateTokens('1234567890'), 10, 'each digit counts')
  assert.equal(estimateTokens('one two'), 2, 'a single space folds into the next word')
  assert.equal(estimateTokens('a\n\nb'), 2, 'a run of line breaks costs one')
  assert.equal(estimateTokens('    x'), 2, 'an indent costs one')
  assert.equal(estimateTokens('{}'), 2)
  assert.equal(estimateTokens('Привет'), 3)
  assert.equal(estimateTokens('🚀'), 3)
  assert.equal(estimateTokens(''), 0)
})

test('numbers are not underestimated the way a flat ratio does', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => String(i + 1)).join('\n')
  assert.ok(estimateTokens(lines) >= lines.length * 0.9, String(estimateTokens(lines)))
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

/** Just enough of the host's Session and event dispatch to run the real flow. */
function harness(info, { provider = 'local', model = 'any', maxTokens } = {}) {
  const listeners = {}
  const log = []
  const session = {
    surface: { nodes: [] },
    eventAt: (seq) => log[seq],
    deriveEventMessage: (event) => event.data.message,
    requestHeader: () => ({ config: { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) } }),
    append(type, data, opts = {}) {
      const event = { type, seq: log.length, data, ...opts }
      log.push(event)
      if (opts.surfaceOp === 'append') session.surface.nodes.push(event.seq)
      if (typeof opts.surfaceOp === 'object') {
        const i = session.surface.nodes.indexOf(opts.surfaceOp.startSeq)
        assert.ok(i >= 0, 'replaces a node that is on the surface')
        session.surface.nodes[i] = event.seq
      }
      return event
    },
  }
  const agent = { session }
  const ctx = {
    on: (name, fn, options) => {
      listeners[name] = { fn, options }
      return () => {}
    },
    llm: {
      calls: 0,
      async resolveModelInfo() {
        this.calls++
        if (info instanceof Error) throw info
        return info
      },
    },
    tokenMeter: { estimateMessage: (message) => estimateTokens(message.content.map((b) => b.text ?? '').join('')) },
    logger: { warn() {} },
  }
  let calls = 0
  return {
    ctx,
    agent,
    session,
    log,
    listeners,
    /** One tool call through the real listeners, then the result appended as the agent loop does. */
    async result(name, text) {
      const callId = `c${++calls}`
      await listeners['tools/post-execute'].fn({ agent, name, callId }, {}, async () => ({ kind: 'accept' }))
      return session.append(
        'tool/result',
        { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } },
        { surfaceOp: 'append' },
      ).seq
    },
    preStep: () => listeners['agent/pre-step'].fn({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter' })),
    /** What the model is sent: the surface, not the log. */
    view: () => session.surface.nodes.map((seq) => log[seq].data.message.content[0].text),
  }
}

const BIG = 'x'.repeat(40000)
const WINDOW_8K = { context: { contextWindow: 8192 }, defaultMaxTokens: 2048 }

test('the model view shrinks and the log keeps the real output', async () => {
  const h = harness(WINDOW_8K)
  apply(h.ctx, {})
  await h.preStep()
  const seq = await h.result('bash', BIG)
  await h.preStep()
  assert.equal(h.log[seq].data.message.content[0].text, BIG, 'the original stays in the log')
  const [seen] = h.view()
  const tokens = estimateTokens(seen)
  assert.ok(tokens > 800 && tokens <= 930, String(tokens))
  assert.match(seen, /omitted/)
})

test('the write is an adjacent shadow price and replacement, as the host pruner writes it', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  await h.preStep()
  const seq = await h.result('bash', BIG)
  await h.preStep()
  const price = h.log[seq + 1]
  const replacement = h.log[seq + 2]
  assert.equal(price.type, 'compaction/prune')
  assert.deepEqual(price.data.shadowedSeqs, [seq])
  assert.deepEqual(price.data.shadowedRange, { start: seq, end: seq })
  assert.equal(price.data.shadowedTokenCount, estimateTokens(BIG))
  assert.equal(replacement.type, 'tool/result')
  assert.equal(replacement.seq, price.seq + 1)
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: seq, endSeq: seq })
  assert.deepEqual(replacement.sourceEventSeqs, [seq])
  assert.equal(replacement.data.turn, 1, 'the rest of the event data is preserved')
})

test('runs first on pre-step and always hands on to the next listener', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  assert.equal(h.listeners['agent/pre-step'].options?.prepend, true)
  const decision = await h.preStep()
  assert.deepEqual(decision, { kind: 'enter' })
})

test('read keeps complete lines from the start; shell keeps head and tail', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  await h.preStep()
  await h.result('read', readOutput(1, 930, 931))
  await h.result('bash', `${'y'.repeat(30000)}END_MARK`)
  await h.preStep()
  const [read, bash] = h.view()
  assert.match(read, /Use offset=\d+ to continue/)
  assert.ok(!read.includes('offset=931'))
  assert.ok(bash.endsWith('END_MARK'))
})

test('each result is handled once, and replacements are not revisited', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  await h.preStep()
  await h.result('bash', BIG)
  await h.preStep()
  const length = h.log.length
  await h.preStep()
  await h.preStep()
  assert.equal(h.log.length, length)
  await h.result('bash', 'small')
  await h.preStep()
  assert.equal(h.log.length, length + 1, 'a result within budget writes nothing')
})

test('history from before the first step is left alone', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  h.session.append('tool/result', { message: { toolCallId: 'old', content: [{ type: 'text', text: BIG }] } }, { surfaceOp: 'append' })
  await h.preStep()
  await h.preStep()
  assert.equal(h.log.length, 1)
  assert.equal(h.view()[0], BIG)
})

test('another producer\'s replacement is never reduced again', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  await h.preStep()
  const seq = await h.result('bash', 'small')
  h.session.append('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: BIG }] } }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
  await h.preStep()
  assert.equal(h.view()[0], BIG)
})

test('caches model info, and request maxTokens overrides the model default', async () => {
  const h = harness(WINDOW_8K, { maxTokens: 0 })
  installResultBudget(h.ctx)
  await h.preStep()
  await h.result('bash', BIG)
  await h.preStep()
  const tokens = estimateTokens(h.view()[0])
  assert.ok(tokens > 1150 && tokens <= 1230, String(tokens)) // 0.15 × 8192 ≈ 1229
  await h.result('bash', BIG)
  await h.preStep()
  assert.equal(h.ctx.llm.calls, 1)
})

test('unknown window or lookup failure uses the fallback', async () => {
  const h = harness(new Error('offline'))
  installResultBudget(h.ctx, { fallbackTokens: 500 })
  await h.preStep()
  await h.result('bash', BIG)
  await h.preStep()
  assert.ok(estimateTokens(h.view()[0]) <= 500)
})

test('excluded tools and small results are left alone', async () => {
  const h = harness({ context: { contextWindow: 4096 } })
  installResultBudget(h.ctx, { exclude: ['mcp_*'] })
  await h.preStep()
  await h.result('mcp_github_search', BIG)
  await h.result('bash', 'ok')
  await h.preStep()
  assert.deepEqual(h.view(), [BIG, 'ok'])
})

test('a refused write never breaks the turn', async () => {
  const h = harness(WINDOW_8K)
  installResultBudget(h.ctx)
  await h.preStep()
  await h.result('bash', BIG)
  h.session.append = () => {
    throw new Error('session refused')
  }
  assert.deepEqual(await h.preStep(), { kind: 'enter' })
})
