# dsh-result-budget

English | [中文](README.zh.md)

Size every DeepSeek Harness tool result to **the active model's context window**. Local and on-device models with small windows are no longer flooded by a single `cat` or `read`, and the budget follows you when you switch models — nothing is tuned for one specific model.

## Why

dsh caps tool output with fixed numbers: `read` 2000 lines / 50 KB, bash 16 000 chars, spill-policy a fixed token count. Fine for a 128k cloud model, far too much for a 4k–32k local one:

- A 50 KB `read` is ~13k tokens — an 8k-window model is full after one call.
- Automatic compaction only runs once the conversation is *already* near the window, so it cannot stop one result from filling it.
- Small models degrade quickly with long context; irrelevant output hurts quality and speed even without overflow.

## How it works

On every `tools/post-execute`:

```
budget = clamp(ratio × (contextWindow − reservedOutput), minTokens, maxTokens)
```

- `contextWindow` and reserved output are resolved exactly like the official `dsh-compaction-basic`: the session's routed provider/model through `llm.resolveModelInfo`; reserved output is the request's `maxTokens`, else the model default.
- Text over budget keeps the **first 75 % and last 25 %** (errors usually sit at the end) with a one-line notice telling the model how to see the rest: `offset/limit` for `read`, `grep/head/tail` for shell tools.
- Token estimate matches the host's 4 chars/token, but CJK counts 1 char/token so Chinese/Japanese/Korean output is not underestimated.
- Images and other non-text blocks pass through. Calls blocked by other listeners and structured-value replacements are left alone.
- Without a declared `contextWindow` (or if the lookup fails) `fallbackTokens` applies.

With the defaults:

| Window (reserved output) | Per-result budget |
|---|---|
| 4k (1k) | ≈ 460 tokens |
| 8k (2k) | ≈ 920 tokens |
| 32k (4k) | ≈ 4300 tokens |
| 128k and up | 8000 tokens (cap) |
| unknown | 2000 tokens |

## Install

```bash
dsh plugin --profile <name> add "github:<owner>/dsh-result-budget"
```

As a bundle it applies to **every agent** in the profile.

### Only for one agent preset

Skip the bundle and list it in the preset's `plugins` — it then covers only that preset's agents:

```yaml
- insert:
    - id: preset-local
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: local
        name: Local
        plugins:
          # ...the preset's own tools...
          - id: result-budget
            name: dsh-result-budget
            config:
              ratio: 0.15
```

Or compose it from your own plugin:

```js
import { installResultBudget } from 'dsh-result-budget'

export function apply(ctx) {
  ctx.inject(['llm'], (ctx) => installResultBudget(ctx, { ratio: 0.1 }))
}
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `ratio` | `0.15` | Max share of the usable window one result may take, (0, 1] |
| `minTokens` | `384` | Budget floor |
| `maxTokens` | `8000` | Budget ceiling, so large-window models don't get huge results either |
| `fallbackTokens` | `2000` | Budget when the window is unknown |
| `headShare` | `0.75` | Share of the kept text taken from the start; the rest is the tail |
| `exclude` | `[]` | Tool names to skip, `*` wildcards allowed, e.g. `["mcp_*"]` |

Invalid config (unknown key, ratio out of range, non-positive integer, `minTokens > maxTokens`) fails at load time instead of silently falling back.

## Relation to built-in components

- **tool-result-pruner** trims *historic* results only when compaction triggers; this plugin limits a result as it *enters* the conversation. Use both.
- **spill-policy** uses a fixed token cap, stores the full result on disk, and skips `read`. This plugin scales with the window and covers every tool; stack spill-policy on top if you want a recoverable full copy.
- **Per-tool caps** (`readLimit`, `maxOutputChars`) can stay at their defaults; this plugin runs after them.

## Known limitations

- Budgets use an estimate, not real tokenization; conservative for code and English, possibly off for rare scripts.
- Omitted text is not stored. The model has to fetch it again with `read`/`grep`; stack spill-policy for a recoverable copy.
- The defaults are rules of thumb, not the result of a systematic evaluation. Comparison data across models is welcome.

## Development

```bash
npm test
```

Node 20+ built-ins only; no runtime dependencies.

## License

MIT
