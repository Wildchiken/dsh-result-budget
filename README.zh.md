# dsh-result-budget

[English](README.md) | 中文

按**当前模型的上下文窗口**给 DeepSeek Harness 的每个工具结果限量。窗口小的本地模型、端侧模型不再被一次 `cat` 或一次 `read` 撑爆；换模型时预算自动跟着变，不用为某个模型调参数。

## 为什么需要

dsh 自带的上限都是固定数字：`read` 一次 2000 行 / 50 KB，bash 16000 字符，spill-policy 是写死的 token 数。这些数字对 128k 的云端模型合适，对 4k–32k 窗口的本地模型就太大了：

- 一个 50 KB 的 `read` 约 1.3 万 token，8k 窗口的模型一次就满。
- 自动压缩只在对话**已经**逼近窗口时才运行，挡不住「单个结果就占满窗口」。
- 小模型在长上下文里退化明显，即使没溢出，塞进去的无关输出也会拉低效果和速度。

## 它怎么算

每一步开始前，针对上一步之后新到的结果：

```
预算 = max(ratio × (contextWindow − 预留输出), minTokens)   # 设了 maxTokens 时不超过它
```

- `contextWindow` 和「预留输出」的取法与官方 `dsh-compaction-basic` 一致：从会话实际路由的 provider/model 调 `llm.resolveModelInfo`；预留输出 = 本次请求的 `maxTokens`，没有就用模型默认值。
- 文本超出预算时保留**开头 75% + 结尾 25%**（报错通常在结尾），中间替换为一句提示，告诉模型怎样看被省略的部分，比如 shell 类提示用 `grep/head/tail`。
- `read` 例外：只从开头保留**完整的行**，并写明接着读的 `offset`。分页读文件时中间留缺口会被悄悄跳过，所以不保留结尾。如果连一行都放不下，提示改用 `bash`，而不是让模型回到同一个 offset。
- token 估算按文本类型计算：每个数字算一个 token，标点和中日韩字符逐个计，字母按单词长度计。宿主用的固定 4 字符/token 在数字和哈希上最多差 4 倍。权重是用三个本地模型报告的 token 数拟合的，再用没参与拟合的文件验证：平均偏差 6%，固定比例是 25%。
- 图片等非文本块原样保留。插件第一次看到会话之前已有的历史不动，这样不会让模型服务商的提示词缓存失效。
- **只改模型看到的内容。** 会话日志保留工具的真实输出，你仍然能看到。写法和宿主自带的 tool-result-pruner 相同：先写一条 `compaction/prune` 记账，再写一条替换该节点的 `tool/result`。需要 `dsh-token-meter`，基础组合包里已经有。
- 模型没声明 `contextWindow` 或查询失败时，使用 `fallbackTokens`。

默认参数下的效果：

| 模型窗口（预留输出） | 单个结果预算 |
|---|---|
| 4k（1k） | ≈ 460 token |
| 8k（2k） | ≈ 920 token |
| 32k（4k） | ≈ 4300 token |
| 128k（8k） | ≈ 18400 token（通常工具自身的上限会先生效） |
| 未知 | 2000 token |

## 有没有用？

用 6 个大输出任务，在 LM Studio 上跑 Spark X2.6 4B，通过 DeepSeek Harness 的 headless 模式，分别关闭和打开插件（v0.2.1）。任务、设置和原始结果在 [bench/](bench/)。

| 窗口 | 关闭插件 | 打开插件 | 撑满上下文中断（关 / 开） |
|---|---|---|---|
| 8k | 7 / 12 | **12 / 12** | 4 / 0 |
| 16k | 9 / 12 | **11 / 12** | 1 / 1，另有关闭时 2 次超时 |
| 32k | **11 / 12** | 4 / 6 | 1 / 0 |

- **8k 和 16k：** 按任务配对比较，只有打开时成功 7 次，只有关闭时成功 0 次（p≈0.016）。平均也更快（8k 48 对 69 秒，16k 57 对 108 秒）。
- **32k：** 可能帮倒忙。两次失败都是本来放得下的结果仍被裁剪：一次 `read` 在模型需要的那一行之前被截断，一次 `grep` 的关键行落在被删掉的中间部分。32k 样本较少（打开插件只跑了 6 次）。窗口 32k 及以上的模型，建议调高 `ratio` 或者不装。
- 只测了一个模型，任务也是专门挑的大输出场景，所以这组数据说明的是它在哪种情况下有用，不代表有用的频率。

另外测试了“按上下文剩余空间裁剪”代替固定比例：32k 更好（12 / 12），8k 和 16k 更差，所以没有发布。

**小窗口下宿主还会压缩输出上限。** DeepSeek Harness 使用的模型调用库 pi-ai 会按 `输出上限 = 窗口 − 估算输入 − 4096`（最少为 1）来设置输出上限。在 8k 窗口里，上下文超过大约 4k token 后模型就只剩 1 个 token，对话会以 `max-tokens` 结束。上表中关闭插件时的失败，大多是这个原因。

## 安装

```bash
dsh plugin --profile <name> add "github:Wildchiken/dsh-result-budget"
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
| `maxTokens` | `null` | 可选的预算上限；默认不设，大窗口模型不会被白白裁剪 |
| `fallbackTokens` | `2000` | 拿不到窗口时的预算 |
| `headShare` | `0.75` | 截断时开头所占比例，其余给结尾；对 `read` 不生效 |
| `exclude` | `[]` | 不处理的工具名，支持 `*` 通配，如 `["mcp_*"]` |

非法配置（未知键、比例越界、非正整数、`minTokens > maxTokens`）在加载时直接报错，不会悄悄回退到默认值。

## 与官方组件的关系

- **tool-result-pruner**：只在压缩触发时修剪**历史**结果；本插件在结果**进入**对话时就限量。两者可以同时用。
- **spill-policy**：基础组合包已启用，固定上限 12500 token，把完整结果存成模型能读取的文件，不处理 `read`。它先运行，而本插件会保留文本结尾，也就是它的提示所在的位置。介于本插件预算和它的上限之间的结果不会存文件。
- **工具自身上限**（`readLimit`、`maxOutputChars`）：保持默认即可，本插件在其之后生效。

## 已知限制

- 上限用的是估算值，不是模型自己的分词器。权重来自三个本地模型，其他模型上可能有偏差。对会把数字合并成组的模型，数字和哈希会估高，这类结果会比实际需要裁得早一些。
- 除非 spill-policy 存了文件，否则模型读不到被省略的内容，只能重新获取。对 shell 类工具，提示建议缩小输出后重新运行，有副作用的命令会因此再执行一次。
- 小模型可能不理会提示。用本地 4B 模型测试时，它跳过了提示的 `offset`，改用 `grep`。
- 默认参数只在一个本地模型上测过（见[有没有用？](#有没有用)）。窗口 32k 及以上时可能裁掉本来放得下的内容。欢迎提交其他模型的对比数据。

## 相关项目

[dsh-tool-output-budget](https://github.com/argszero/dsh-tool-output-budget) 出现得更早，同样在结果进入时限量并保留日志，它的上限是固定字符数。想让所有模型用同一个数字就选它，想让上限跟着模型窗口变就选这个插件。

## 开发

```bash
npm test
```

依赖只有 Node 20+ 内置模块，没有运行时依赖。

## 许可

MIT
