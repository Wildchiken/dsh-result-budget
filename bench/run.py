#!/usr/bin/env python3
"""A/B benchmark: the same tasks with the plugin on and off, per context window.

usage: run.py --work DIR --cli BIN.js [--windows 8192,16384,32768] [--reps 1] [--tasks a,b] [--arms on,off] [--timeout 300]
Any arm except "off" mounts the plugin; the label says which version of it ran
("on" = v0.2.1 fixed share of the window, "room" = trims by remaining room,
"room2" = room plus the line where the client starves the output).
Results are appended to results.jsonl next to this file; finished cells are skipped.
"""
import argparse, glob, json, os, random, shutil, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tasks as T

MODEL = 'spark-x2.6-4b-abliterated'
LMS = os.path.expanduser('~/.lmstudio/bin/lms')


def load(window):
    subprocess.run([LMS, 'unload', '--all'], capture_output=True)
    r = subprocess.run([LMS, 'load', MODEL, '-c', str(window), '--parallel', '1', '--identifier', MODEL, '-y'], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'load failed: {r.stderr[-300:]}')


def stats(path):
    out = subprocess.run(['zstd', '-dc', path], capture_output=True).stdout.decode('utf8', 'ignore')
    s = dict(steps=0, input_total=0, input_peak=0, output_total=0, tool_calls=0, prunes=0, compactions=0, end=None, tools=None)
    for line in out.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t, d = e.get('type'), e.get('data') or {}
        if t == 'assistant/message':
            u = d['message'].get('usage') or d.get('usage') or {}
            s['steps'] += 1
            s['input_total'] += u.get('inputTokens') or 0
            s['output_total'] += u.get('outputTokens') or 0
            s['input_peak'] = max(s['input_peak'], u.get('inputTokens') or 0)
        elif t == 'tool/call':
            s['tool_calls'] += 1
        elif t == 'compaction/prune':
            s['prunes'] += 1
        elif t and t.startswith('compaction/'):
            s['compactions'] += 1
        elif t == 'turn/end':
            r = d.get('reason') or {}
            s['end'] = r.get('kind')
            if r.get('kind') == 'error':
                s['error'] = str((r.get('error') or {}).get('message'))[:200]
        elif t == 'request/header' and (d.get('header') or {}).get('tools') is not None:
            s['tools'] = len(d['header']['tools'])
    return s


def one(a, window, task, arm, rep):
    rid = f'{window}-{task}-{arm}-{rep}'
    w = os.path.join(a.work, 'w', rid)
    shutil.rmtree(w, ignore_errors=True)
    os.makedirs(w)
    prompt = T.TASKS[task](w)
    home = os.path.join(a.work, 'home')
    env = dict(os.environ, DSH_HOME=home, LMSTUDIO_API_KEY='local', BENCH_WINDOW=str(window), BENCH_MAXTOKENS=str(min(window // 4, 4096)))
    cmd = ['node', a.cli, '--profile', 'bench']
    if arm != 'off':
        cmd += ['--patch', os.path.join(a.work, 'budget-on.yml')]
    cmd += ['--permission-mode', 'workspace-write', '--approval-policy', 'never', prompt]
    t0 = time.time()
    timed_out = False
    try:
        p = subprocess.run(cmd, cwd=w, env=env, capture_output=True, text=True, timeout=a.timeout)
        answer, code, err = p.stdout, p.returncode, p.stderr
    except subprocess.TimeoutExpired as e:
        answer, code, err, timed_out = (e.stdout or b'').decode('utf8', 'ignore') if isinstance(e.stdout, bytes) else (e.stdout or ''), None, '', True
    secs = round(time.time() - t0, 1)
    rec = dict(window=window, task=task, arm=arm, rep=rep, ok=False, secs=secs, exit=code, timed_out=timed_out, answer=answer[-400:], stderr=err[-300:])
    try:
        rec['ok'] = bool(T.judge(task, w, answer)) and not timed_out
    except Exception as e:
        rec['judge_error'] = str(e)
    sessions = glob.glob(os.path.join(home, 'sessions', f'*{rid}*', '*', 'session.v4.jsonl.zstd'))
    if sessions:
        rec.update(stats(max(sessions, key=os.path.getmtime)))
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True); ap.add_argument('--cli', required=True)
    ap.add_argument('--windows', default='8192,16384,32768'); ap.add_argument('--reps', type=int, default=1)
    ap.add_argument('--arms', default='on,off')
    ap.add_argument('--tasks', default=','.join(T.TASKS)); ap.add_argument('--timeout', type=int, default=300)
    a = ap.parse_args()
    out = os.path.join(HERE, 'results.jsonl')
    done = set()
    if os.path.exists(out):
        for l in open(out):
            r = json.loads(l); done.add((r['window'], r['task'], r['arm'], r['rep']))
    rng = random.Random(42)
    for rep in range(1, a.reps + 1):
        for window in [int(x) for x in a.windows.split(',')]:
            cells = [(t, arm) for t in a.tasks.split(',') for arm in a.arms.split(',')]
            rng.shuffle(cells)
            todo = [c for c in cells if (window, c[0], c[1], rep) not in done]
            if not todo:
                continue
            load(window)
            for task, arm in todo:
                r = one(a, window, task, arm, rep)
                with open(out, 'a') as f:
                    f.write(json.dumps(r, ensure_ascii=False) + '\n')
                print(window, task.ljust(13), arm.ljust(3), 'OK ' if r['ok'] else 'FAIL', r['secs'], 's', 'steps', r.get('steps'), 'peak', r.get('input_peak'), 'end', r.get('end'), flush=True)
    subprocess.run([LMS, 'unload', '--all'], capture_output=True)
    print('finished', flush=True)


main()
