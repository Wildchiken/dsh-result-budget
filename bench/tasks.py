"""Fixed benchmark tasks: each builds a workspace and judges the outcome.

Every task forces the model to deal with tool output that is large for a small
context window. Fixtures are deterministic, so both arms see identical files.
"""
import json
import os
import random
import subprocess


def _noise(rng, n):
    words = ['compile', 'link', 'fetch', 'resolve', 'cache', 'hash', 'emit', 'bundle', 'scan', 'load']
    mods = ['core', 'net', 'ui', 'db', 'auth', 'io', 'gfx', 'util']
    return [f'[{i:05d}] INFO {rng.choice(words)} module {rng.choice(mods)}/{rng.randint(1, 99)} ok in {rng.randint(1, 900)}ms' for i in range(1, n + 1)]


def needle(w):
    with open(f'{w}/notes.txt', 'w') as f:
        for i in range(1, 1201):
            f.write(f'line {i:05d} the secret code is 7391-KESTREL\n' if i == 700
                    else f'line {i:05d} the quick brown fox jumps over the lazy dog\n')
    return 'Find the secret code in notes.txt and tell me the code and its line number.'


def log_error(w):
    rng = random.Random(1)
    lines = _noise(rng, 2500)
    lines[1499] = "[01500] FATAL E4721 missing config key 'retry_timeout' in deploy.toml"
    with open(f'{w}/build.log', 'w') as f:
        f.write('\n'.join(lines) + '\n')
    return 'The build failed. Look at build.log and tell me the error code and which config key is missing.'


def fix_bug(w):
    with open(f'{w}/calc.py', 'w') as f:
        f.write('def average(values):\n    return sum(values) / (len(values) + 1)\n')
    body = ['import calc', '', 'for i in range(300):',
            "    print(f'checking dataset {i:03d} of 300: loading records, validating schema, ok')",
            '', 'assert calc.average([2, 4, 6]) == 4, "average([2, 4, 6]) should be 4"', "print('ALL PASSED')", '']
    with open(f'{w}/test_calc.py', 'w') as f:
        f.write('\n'.join(body))
    return 'python3 test_calc.py is failing. Find out why and fix the bug in calc.py so the test passes.'


def json_max(w):
    rng = random.Random(2)
    rows = [{'id': f'rec-{i:04d}', 'owner': rng.choice(['ann', 'bob', 'cid', 'dee']), 'score': rng.randint(0, 9000),
             'tags': rng.sample(['a', 'b', 'c', 'd', 'e'], 2)} for i in range(400)]
    rows[271]['score'] = 9731
    with open(f'{w}/data.json', 'w') as f:
        json.dump(rows, f, indent=2)
    return 'Which record in data.json has the highest score? Tell me its id and its score.'


def find_def(w):
    rng = random.Random(3)
    os.makedirs(f'{w}/pkg/core')
    for i in range(40):
        rows = [f'def helper_{i}_{n}(x):\n    return x + {n}  # call resolve_token_budget later\n' for n in range(120)]
        if i == 17:
            rows.insert(rng.randint(30, 90), 'def resolve_token_budget(window, ratio):\n    return int(window * ratio)\n')
        with open(f'{w}/pkg/core/limits_{i}.py', 'w') as f:
            f.write('\n'.join(rows))
    return 'Which file under pkg/ defines the function resolve_token_budget? Tell me the file path.'


def count_status(w):
    rng = random.Random(4)
    count = 0
    with open(f'{w}/access.log', 'w') as f:
        for i in range(5000):
            status = rng.choice([200] * 20 + [404, 500, 503])
            count += status == 503
            f.write(f'10.0.{rng.randint(0, 255)}.{rng.randint(0, 255)} GET /api/v1/item/{i} {status} {rng.randint(90, 9000)}\n')
    with open(f'{w}/.expected', 'w') as f:
        f.write(str(count))
    return 'How many requests in access.log returned status 503? Give me the exact number.'


def _has(answer, *needles):
    return all(n.lower() in answer.lower() for n in needles)


def judge(task, w, answer):
    if task == 'needle':
        return _has(answer, '7391-KESTREL') and '700' in answer
    if task == 'log_error':
        return _has(answer, 'E4721', 'retry_timeout')
    if task == 'json_max':
        return _has(answer, 'rec-0271') and '9731' in answer
    if task == 'find_def':
        return _has(answer, 'limits_17.py')
    if task == 'count_status':
        import re
        return open(f'{w}/.expected').read() in re.findall(r'\d+', answer.replace(',', ''))
    if task == 'fix_bug':
        r = subprocess.run(['python3', 'test_calc.py'], cwd=w, capture_output=True, timeout=30)
        return r.returncode == 0 and b'ALL PASSED' in r.stdout
    raise KeyError(task)


TASKS = {'needle': needle, 'log_error': log_error, 'fix_bug': fix_bug,
         'json_max': json_max, 'find_def': find_def, 'count_status': count_status}
