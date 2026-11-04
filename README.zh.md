# dsh-result-budget

[English](README.md) | 中文

按**当前模型的上下文窗口**给 DeepSeek Harness 的每个工具结果限量。窗口小的本地模型、端侧模型不再被一次 `cat` 或一次 `read` 撑爆；换模型时预算自动跟着变，不用为某个模型调参数。

## 为什么需要

dsh 自带的上限都是固定数字：`read` 一次 2000 行 / 50 KB，bash 16000 字符，spill-policy 是写死的 token 数。这些数字对 128k 的云端模型合适，对 4k–32k 窗口的本地模型就太大了：

- 一个 50 KB 的 `read` 约 1.3 万 token，8k 窗口的模型一次就满。
- 自动压缩只在对话**已经**逼近窗口时才运行，挡不住「单个结果就占满窗口」。
- 小模型在长上下文里退化明显，即使没溢出，塞进去的无关输出也会拉低效果和速度。

## 它怎么算

每次工具调用结束（`tools/post-execute`）时：

```
预算 = clamp(ratio × (contextWindow − 预留输出), minTokens, maxTokens)
```

- `contextWindow` 和「预留输出」的取法与官方 `dsh-compaction-basic` 一致：从会话实际路由的 provider/model 调 `llm.resolveModelInfo`；预留输出 = 本次请求的 `maxTokens`，没有就用模型默认值。
- 文本超出预算时保留**开头 75% + 结尾 25%**（报错通常在结尾），中间替换为一句提示，告诉模型怎样看被省略的部分：`read` 提示用 `offset/limit`，shell 类提示用 `grep/head/tail`。
- token 估算沿用宿主的 4 字符/token；中日韩字符按 1 字符/token，避免中文输出被低估。
- 图片等非文本块原样保留；被其他插件 block 的调用、改写成结构化值的结果不动。
- 模型没声明 `contextWindow` 或查询失败时，使用 `fallbackTokens`。

默认参数下的效果：

| 模型窗口（预留输出） | 单个结果预算 |
|---|---|
| 4k（1k） | ≈ 460 token |
| 8k（2k） | ≈ 920 token |
| 32k（4k） | ≈ 4300 token |
| 128k 及以上 | 8000 token（封顶） |
| 未知 | 2000 token |

## 安装

```bash
dsh plugin --profile <name> add "github:<owner>/dsh-result-budget"
```

作为 bundle 挂载时对 profile 里**所有 agent** 生效。

### 只用于某个 agent 预设

不要加成 bundle，而是写进预设的 `plugins` 里，这样只影响该预设下的 agent：

```yaml
- insert:
    - id: preset-local
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: local
        name: Local
        plugins:
          # ...预设自己的工具...
          - id: result-budget
            name: dsh-result-budget
            config:
              ratio: 0.15
```

也可以在自己的插件里组合：

```js
import { installResultBudget } from 'dsh-result-budget'

export function apply(ctx) {
  ctx.inject(['llm'], (ctx) => installResultBudget(ctx, { ratio: 0.1 }))
}
```

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `ratio` | `0.15` | 单个结果最多占可用窗口的比例，(0, 1] |
| `minTokens` | `384` | 预算下限 |
| `maxTokens` | `8000` | 预算上限，大窗口模型不会因此收到超长结果 |
| `fallbackTokens` | `2000` | 拿不到窗口时的预算 |
| `headShare` | `0.75` | 截断时开头所占比例，其余给结尾 |
| `exclude` | `[]` | 不处理的工具名，支持 `*` 通配，如 `["mcp_*"]` |

非法配置（未知键、比例越界、非正整数、`minTokens > maxTokens`）在加载时直接报错，不会悄悄回退到默认值。

## 与官方组件的关系

- **tool-result-pruner**：只在压缩触发时修剪**历史**结果；本插件在结果**进入**对话时就限量。两者可以同时用。
- **spill-policy**：固定 token 上限，并把完整结果落盘；不处理 `read`。本插件按窗口变化，处理所有工具；需要完整结果落盘时可以叠加 spill-policy。
- **工具自身上限**（`readLimit`、`maxOutputChars`）：保持默认即可，本插件在其之后生效。

## 已知限制

- 截断是按估算 token，不是真实分词；对代码和英文偏保守，对少见字符可能有偏差。
- 被省略的内容不会落盘。模型需要时得重新用 `read`/`grep` 去取；需要可恢复的完整副本请叠加 spill-policy。
- 默认参数是经验值，没有经过系统评测。欢迎提交不同模型下的对比数据。

## 开发

```bash
npm test
```

依赖只有 Node 20+ 内置模块，没有运行时依赖。

## 许可

MIT
