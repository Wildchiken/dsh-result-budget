/**
 * dsh-result-budget — size every tool result to the active model's context window.
 *
 * DeepSeek Harness caps tool output with fixed numbers (read: 2000 lines /
 * 50 KB, bash: 16 000 chars, spill-policy: a fixed token count). Those fit a
 * 128k cloud model and drown a 4k–32k local one. Compaction only runs once the
 * conversation is already under pressure, so one oversized result can still
 * fill the window by itself.
 *
 * Before each step this plugin looks at the results that arrived since the last
 * one and computes, per model,
 *
 *     budget = clamp(ratio × (contextWindow − reservedOutput), minTokens, maxTokens)
 *
 * using the same model lookup as dsh-compaction-basic (routed request header →
 * `llm.resolveModelInfo`; reserved output = request maxTokens ?? model default).
 * Text over budget keeps its head (75 %) and tail (25 %) with a one-line notice
 * telling the model how to see the rest. `read` is the exception: it keeps
 * complete lines from the start and names the exact offset to continue from,
 * because a hole in the middle of a paged file would be skipped silently.
 * Switching models changes the budget automatically; nothing is tuned for a
 * specific model.
 *
 * Only the model's view changes. The write is the pair the host's own
 * tool-result pruner uses: a `compaction/prune` shadow price followed by a
 * `tool/result` that replaces the node on the surface. The session log keeps
 * the tool's real output. It happens on `agent/pre-step` because a turn is open
 * there (a replacement outside one leaves a log that cannot be read back) and
 * because that dispatch is filtered by agent, so a preset-scoped mount stays
 * inside its preset. The listener is prepended so compaction measures the
 * reduced surface instead of summarizing weight that was already removed.
 *
 * Mounted globally it covers every agent; mounted inside an agent preset it
 * covers only that preset's agents (Cordis scope-filtered dispatch).
 */

export const name = 'result-budget'
export const inject = ['llm', 'tokenMeter']

export const DEFAULTS = Object.freeze({
  ratio: 0.15,
  minTokens: 384,
  maxTokens: null, // no ceiling: a large window has room, and tools keep their own caps
  fallbackTokens: 2000,
  headShare: 0.75,
  exclude: [],
})

// CJK, Hangul, full-width forms: roughly one token per character.
const DENSE = /[⺀-鿿가-힯豈-﫿＀-￯]/
// Matches the host token meter's density for everything else.
const CHARS_PER_TOKEN = 4
const NOTICE_RESERVE = 48

/** Fail loud on bad config instead of silently changing behaviour. */
export function resolveConfig(config = {}) {
  const out = { ...DEFAULTS, ...(config ?? {}) }
  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(config ?? {})) {
    if (!known.has(key)) throw new Error(`dsh-result-budget: unknown config key "${key}" (allowed: ${[...known].join(', ')})`)
  }
  if (!(out.ratio > 0 && out.ratio <= 1)) throw new Error(`dsh-result-budget: ratio must be in (0, 1], got ${out.ratio}`)
  if (!(out.headShare >= 0 && out.headShare <= 1)) throw new Error(`dsh-result-budget: headShare must be in [0, 1], got ${out.headShare}`)
  for (const key of ['minTokens', 'maxTokens', 'fallbackTokens']) {
    if (key === 'maxTokens' && out[key] === null) continue
    if (!Number.isInteger(out[key]) || out[key] <= 0) throw new Error(`dsh-result-budget: ${key} must be a positive integer, got ${out[key]}`)
  }
  if (out.maxTokens !== null && out.minTokens > out.maxTokens) throw new Error(`dsh-result-budget: minTokens (${out.minTokens}) exceeds maxTokens (${out.maxTokens})`)
  if (!Array.isArray(out.exclude) || out.exclude.some((p) => typeof p !== 'string')) {
    throw new Error('dsh-result-budget: exclude must be a list of tool-name patterns')
  }
  return out
}

/** Estimated tokens: dense scripts 1 char/token, everything else 4 chars/token. */
export function estimateTokens(text) {
  let dense = 0
  let other = 0
  for (const ch of text) DENSE.test(ch) ? dense++ : other++
  return dense + Math.ceil(other / CHARS_PER_TOKEN)
}

/** Longest prefix of `chars` (code points) within `tokens`. */
function takeHead(chars, tokens) {
  let used = 0
  let other = 0
  let i = 0
  for (; i < chars.length; i++) {
    if (DENSE.test(chars[i])) used++
    else if (++other % CHARS_PER_TOKEN === 1) used++
    if (used > tokens) break
  }
  return chars.slice(0, i).join('')
}

function takeTail(chars, tokens) {
  return [...takeHead([...chars].reverse(), tokens)].reverse().join('')
}

/** Per-result token budget for a model window. */
export function resolveBudget(contextWindow, reservedOutput, config = DEFAULTS) {
  const { ratio, minTokens, maxTokens, fallbackTokens } = config
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return fallbackTokens
  // A request that reserves most of the window still gets a quarter of it as the base.
  const usable = Math.max(contextWindow - (reservedOutput || 0), contextWindow * 0.25)
  return Math.round(Math.min(maxTokens ?? Infinity, Math.max(minTokens, usable * ratio)))
}

/**
 * Fit `read` output from the start only, ending on a complete numbered line.
 * Keeping a tail here would leave a hole that the tool's own "Use offset=N"
 * footer tells the model to jump over, so the footer goes and the notice names
 * the line right after the last one kept.
 */
function fitRead(text, tokens) {
  const chars = [...text]
  const raw = takeHead(chars, tokens)
  const cut = raw.lastIndexOf('\n')
  const whole = cut >= 0 ? raw.slice(0, cut) : raw
  const close = /<\/content>\s*$/.test(text) ? '\n</content>' : ''
  const last = [...whole.matchAll(/^(\d+): /gm)].at(-1)
  if (last !== undefined) {
    const line = Number(last[1])
    return `${whole}\n\n(Trimmed to fit this model's context window. Showing up to line ${line}. Use offset=${line + 1} to continue.)${close}`
  }
  // Not even one whole line fits: pointing back at the same offset would loop forever.
  const omitted = chars.length - [...raw].length
  return `${raw}\n\n[... ${omitted} characters omitted: this line is too long for this model's context window. Inspect it with bash (grep, cut) ...]${close}`
}

function hintFor(toolName) {
  if (/^(bash|pwsh|shell|terminal)/.test(toolName)) {
    return 'Re-run with narrower output (grep, head, tail, wc) instead of printing everything.'
  }
  return 'Narrow the request to see the omitted part.'
}

/**
 * Fit text blocks into `budget`. Returns undefined when nothing needs to change.
 * Text blocks share the budget in order; non-text blocks pass through untouched.
 */
export function fitContent(content, budget, toolName, headShare = DEFAULTS.headShare) {
  if (!Array.isArray(content)) return undefined
  let total = 0
  for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') total += estimateTokens(block.text)
  if (total <= budget) return undefined

  let remaining = budget
  return content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const cost = estimateTokens(block.text)
    if (cost <= remaining) {
      remaining -= cost
      return block
    }
    const chars = [...block.text]
    const room = Math.max(remaining - NOTICE_RESERVE, 0)
    if (toolName === 'read') {
      remaining = 0
      return { ...block, text: fitRead(block.text, room) }
    }
    const head = takeHead(chars, Math.floor(room * headShare))
    const tail = room > 0 ? takeTail(chars, Math.floor(room * (1 - headShare))) : ''
    const omitted = chars.length - [...head].length - [...tail].length
    remaining = 0
    const notice = `\n\n[... ${omitted} characters omitted to fit this model's context window. ${hintFor(toolName)} ...]\n\n`
    return { ...block, text: head + notice + tail }
  })
}

function matcher(patterns) {
  const regexes = patterns.map(
    (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
  )
  return (toolName) => regexes.some((re) => re.test(toolName))
}

/**
 * Replace one result on the surface, keeping the original in the log.
 * The two appends must stay adjacent: the token meter reads the shadow price as
 * a claim on the very next event, and a replacement with no claim would leave
 * the running total charging for content the request no longer carries.
 * @returns the seq of the replacement.
 */
function replaceOnSurface(session, tokenMeter, seq, event, original, content) {
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: tokenMeter.estimateMessage(original),
  })
  return session.append(
    'tool/result',
    { ...event.data, message: { ...original, content } },
    { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
  ).seq
}

/**
 * Install the listeners on `ctx`. Exported so presets and other plugins can
 * compose it without mounting a separate row.
 * @param ctx - a context that has `llm` and `tokenMeter` available.
 * @param config - see {@link DEFAULTS}.
 */
export function installResultBudget(ctx, config = {}) {
  const options = resolveConfig(config)
  const excluded = matcher(options.exclude)
  const modelInfo = new Map()
  // session → { watermark: newest seq already looked at, names: callId → tool name }
  const sessions = new WeakMap()

  const stateOf = (session) => {
    let state = sessions.get(session)
    if (state === undefined) {
      state = { watermark: undefined, names: new Map() }
      sessions.set(session, state)
    }
    return state
  }

  async function budgetFor(agent, signal) {
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider || agent?.options?.provider
    const model = routed?.model || agent?.options?.model
    if (!provider || !model) return options.fallbackTokens
    const key = `${provider}/${model}`
    let info = modelInfo.get(key)
    if (info === undefined) {
      try {
        info = await ctx.llm.resolveModelInfo(provider, model, signal)
        modelInfo.set(key, info)
      } catch {
        return options.fallbackTokens
      }
    }
    const reserved = routed?.maxTokens ?? info?.defaultMaxTokens ?? 0
    return resolveBudget(info?.context?.contextWindow, reserved, options)
  }

  async function fitNewResults(agent, signal) {
    const session = agent.session
    const state = stateOf(session)
    const nodes = [...session.surface.nodes]

    // First sight of this session: history that was already here stays as it is.
    // Rewriting it would throw away the provider's prompt cache for no new output.
    if (state.watermark === undefined) {
      state.watermark = nodes.length > 0 ? Math.max(...nodes) : -1
      return
    }

    const arrived = []
    for (let i = nodes.length - 1; i >= 0 && nodes[i] > state.watermark; i--) {
      const event = session.eventAt(nodes[i])
      // Only an appended result carries new output, not another producer's replacement.
      if (event?.type === 'tool/result' && event.surfaceOp === 'append') arrived.unshift({ seq: nodes[i], event })
    }
    if (nodes.length > 0) state.watermark = Math.max(state.watermark, ...nodes)
    if (arrived.length === 0) return

    const budget = await budgetFor(agent, signal)
    for (const { seq, event } of arrived) {
      const callId = event.data?.message?.toolCallId
      const toolName = state.names.get(callId)
      state.names.delete(callId)
      if (toolName !== undefined && excluded(toolName)) continue
      if (!session.surface.nodes.includes(seq)) continue
      const original = session.deriveEventMessage(event)
      const content = fitContent(original.content, budget, toolName ?? '', options.headShare)
      if (content === undefined) continue
      const replacement = replaceOnSurface(session, ctx.tokenMeter, seq, event, original, content)
      state.watermark = Math.max(state.watermark, replacement)
    }
  }

  // Result events do not carry the tool name, and read and bash are trimmed differently.
  ctx.on('tools/post-execute', (exec, _result, next) => {
    const session = exec.agent?.session
    if (session !== undefined) stateOf(session).names.set(exec.callId, exec.name)
    return next()
  })

  ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      try {
        if (signal?.aborted !== true) await fitNewResults(agent, signal)
      } catch (error) {
        // Failing to make a request smaller must never break the turn.
        ctx.logger?.warn?.(`result budget skipped: ${error?.message ?? error}`)
      }
      return next()
    },
    { prepend: true },
  )
}

/** Cordis plugin entry. */
export function apply(ctx, config) {
  installResultBudget(ctx, config)
}
