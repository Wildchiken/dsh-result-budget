# Benchmark

Six fixed tasks, run with the plugin on and off, at three context windows. Each run is a fresh workspace and a fresh `dsh --profile headless` process on a local model.

## Tasks

All of them produce tool output that is large for a small window. Fixtures are deterministic, so both arms see the same files.

| Task | What the model has to do | Judged by |
|---|---|---|
| `needle` | Find a code on line 700 of a 1200-line file | The answer names the code and line 700 |
| `log_error` | Find the one fatal line in a 2500-line build log | The answer names the error code and the missing key |
| `fix_bug` | Fix `calc.py` so a noisy test passes | `python3 test_calc.py` passes afterwards |
| `json_max` | Find the record with the highest score in a 400-record JSON | The answer names its id and score |
| `find_def` | Find which of 40 files defines a function | The answer names `limits_17.py` |
| `count_status` | Count the 503s in a 5000-line access log | The answer gives the exact number |

## Setup used

- DeepSeek Harness CLI `0.2.2-rc.1`, headless profile.
- Model: Spark X2.6 4B (Q4_K_M) on LM Studio, loaded with the window under test.
- The headless runner does not run agent presets, so `profile/cordis.patch.yml` rebuilds a Lite-like setup at the top level: only `read`, `write`, `edit` and `bash`, a short system prompt, and the same pruner thresholds. The two arms differ only in `profile/budget-on.yml`.
- `maxTokens` per request was a quarter of the window, at most 4096.
- Timeout 240 to 300 seconds per run.

## Results

`results.jsonl` has one line per run. `arm` is `off` (no plugin) or `on` (v0.2.1). `room` and `room2` were experimental budgets that trimmed by the room left in the context; they did worse and were not released, and are kept for the record.

| Window | Off | v0.2.1 |
|---|---|---|
| 8k | 7 / 12 | 12 / 12 |
| 16k | 9 / 12 | 11 / 12 |
| 32k | 11 / 12 | 4 / 6 |

Paired by task and repetition at 8k and 16k: 7 runs passed only with the plugin, none only without it (two-sided sign test, p ≈ 0.016).

## Running it

```bash
python3 bench/run.py --work /tmp/dsh-bench --cli <path to @deepseek-ai/dsh/lib/bin.js> --windows 8192,16384 --reps 2
```

`--work` must hold `home/profiles/bench/` (the files in `profile/`, plus `node_modules` links to the CLI's `@deepseek-ai` packages and to this plugin) and `budget-on.yml`. The script loads and unloads the model through `lms`, so nothing else should be using LM Studio while it runs. Finished runs are skipped, so an interrupted run can be resumed.
