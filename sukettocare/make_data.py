# script.json から data.js・原稿.md を作る。目安の秒数は文字数から計算する（約 320 字/分）。
import json
S = json.load(open('script.json'))
K = 0.9516  # 1,200 字で 3:45 になるように合わせた係数
GEN = {'ti', 'g1', 'g2', 'g3', 'g4', 'g5', 'cl'}
cum = 0
for s in S:
    if s.get('backup'):
        s['target'] = 0; s['cumEnd'] = round(cum, 1); s['lineStart'] = [0] * len(s['lines']); continue
    n = sum(len(l) for l in s['lines'])
    s['target'] = round((n / 5.6 + 0.3 * len(s['lines']) + 0.5) * K, 1)
    acc = 0; s['lineStart'] = []
    for l in s['lines']:
        s['lineStart'].append(round(acc / n * s['target'], 1)); acc += len(l)
    if s.get('kind', 'video') == 'video':
        s['rate'] = 1.0 if s['id'] in GEN else round(min(1.6, max(0.8, s['clip'] / s['target'])), 2)
    cum += s['target']; s['cumEnd'] = round(cum, 1)
json.dump(S, open('script.json', 'w'), ensure_ascii=False, indent=1)
open('data.js', 'w').write('// 発表の原稿とタイミング（script.json から make_data.py で生成）\nwindow.DECK=' + json.dumps(S, ensure_ascii=False, indent=1) + ';\nwindow.LIMIT=240;\n')
f = lambda x: f"{int(x // 60)}:{int(round(x % 60)):02d}"
main = [s for s in S if not s.get('backup')]
chars = sum(len(l) for s in main for l in s['lines'])
o = [f"# 助っ人ケア 発表原稿（{f(cum)}・約{chars:,}字）", "", "制限 4:00。（目安の秒数／そのページを終える目安の経過時間）", ""]
for i, s in enumerate(S, 1):
    if s.get('backup'):
        o += [f"## {i}. {s['title']}（予備・時間外）", ""] + [f"- {l}" for l in s['lines']] + [""]; continue
    o += [f"## {i}. {s['title']}（{round(s['target'])}秒／ここまで {f(s['cumEnd'])}）", ""] + [f"- {l}" for l in s['lines']] + [""]
open('原稿.md', 'w').write("\n".join(o))
print(chars, 'chars', f(cum), round(cum, 1))
