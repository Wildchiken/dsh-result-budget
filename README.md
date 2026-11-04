# dsh-result-budget

English | [中文](README.zh.md)

Size every DeepSeek Harness tool result to **the active model's context window**. Local and on-device models with small windows are no longer flooded by a single `cat` or `read`, and the budget follows you when you switch models — nothing is tuned for one specific model.

## Why

dsh caps tool output with fixed numbers: `read` 2000 lines / 50 KB, bash 16 000 chars, spill-policy a fixed token count. Fine for a 128k cloud model, far too much for a 4k–32k local one:

- A 50 KB `read` is ~13k tokens — an 8k-window model is full after one call.
- Automatic compaction only runs once the conversation is *already* near the window, so it cannot stop one result from filling it.
- Small models degrade quickly with long context; irrelevant output hurts quality and speed even without overflow.

## How it works

Before each step, for the results that arrived since the last one:

```
budget = max(ratio × (contextWindow − reservedOutput), minTokens)   # capped by maxTokens if you set one
```

- `contextWindow` and reserved output are resolved exactly like the official `dsh-compaction-basic`: the session's routed provider/model through `llm.resolveModelInfo`; reserved output is the request's `maxTokens`, else the model default.
- Text over budget keeps the **first 75 % and last 25 %** (errors usually sit at the end) with a one-line notice telling the model how to see the rest, such as `grep/head/tail` for shell tools.
- `read` is different: it keeps **complete lines from the start** and names the exact `offset` to continue from. A hole in the middle of a paged file would be skipped silently, so no tail is kept. If not even one line fits, the notice points to `bash` instead of back to the same offset.
- The token estimate depends on the kind of text: each digit counts as a token, punctuation and CJK characters count individually, and letters count by word length. A flat 4 chars/token, which the host uses, was off by up to 4× on numbers and hashes. The weights were fitted against the token counts three local models reported, then checked on files that were not part of the fit: 6 % average error, against 25 % for the flat ratio.
- Images and other non-text blocks pass through. History from before the plugin first saw the session is left alone, so the provider's prompt cache survives.
- **Only the model's view changes.** The session log keeps the tool's real output, so you can still see it. The write is the pair the host's own tool-result pruner uses: a `compaction/prune` shadow price, then a `tool/result` that replaces the node on the surface. It needs `dsh-token-meter`, which is in the base bundle.
- Without a declared `contextWindow` (or if the lookup fails) `fallbackTokens` applies.

With the defaults:

| Window (reserved output) | Per-result budget |
|---|---|
| 4k (1k) | ≈ 460 tokens |
| 8k (2k) | ≈ 920 tokens |
| 32k (4k) | ≈ 4300 tokens |
| 128k (8k) | ≈ 18 400 tokens (tools' own caps usually apply first) |
| unknown | 2000 tokens |

## Install

```bash
dsh plugin --profile <name> add "github:Wildchiken/dsh-result-budget"
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
| `maxTokens` | `null` | Optional budget ceiling; none by default, so large-window models lose nothing |
| `fallbackTokens` | `2000` | Budget when the window is unknown |
| `headShare` | `0.75` | Share of the kept text taken from the start; the rest is the tail. Not used for `read` |
| `exclude` | `[]` | Tool names to skip, `*` wildcards allowed, e.g. `["mcp_*"]` |

Invalid config (unknown key, ratio out of range, non-positive integer, `minTokens > maxTokens`) fails at load time instead of silently falling back.

## Relation to built-in components

- **tool-result-pruner** trims *historic* results only when compaction triggers; this plugin limits a result as it *enters* the conversation. Use both.
- **spill-policy** is in the base bundle with a fixed cap (12 500 tokens), saves the full result to a file the model can read, and skips `read`. It runs first, and this plugin keeps the end of the text, where spill's notice sits. Results between this budget and spill's cap get no file.
- **Per-tool caps** (`readLimit`, `maxOutputChars`) can stay at their defaults; this plugin runs after them.

## Known limitations

- Budgets use an estimate, not the model's tokenizer. It was fitted on three local models and may differ on others. It runs high on numbers and hashes for models that group digits, so those results get trimmed sooner than necessary.
- The model cannot read what was omitted unless spill-policy saved a file. It has to fetch it again, and for shell tools the notice suggests re-running with narrower output, which runs a command with side effects a second time.
- A small model may ignore the notice. In a test with a local 4B model it skipped the suggested `offset` and used `grep` instead.
- The defaults are rules of thumb, not the result of a systematic evaluation. Comparison data across models is welcome.

## Related

[dsh-tool-output-budget](https://github.com/argszero/dsh-tool-output-budget) came first and also bounds each result as it arrives and keeps the log intact. Its budget is a fixed character count. Choose it if you want one number for every model; choose this plugin if the budget should follow the model's window.

## Development

```bash
npm test
```

Node 20+ built-ins only; no runtime dependencies.

## License

MIT
