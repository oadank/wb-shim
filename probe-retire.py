import re, sys
src = open(r'C:\D\opt\litellm\venv\litellm_config.yaml', encoding='utf-8').read()
lines = src.split('\n')

def probe(litellm_name):
    cur = None
    hits = []
    for i, l in enumerate(lines):
        m = re.match(r'^\s*-\s*model_name:\s*(\S+)\s*$', l)
        if m:
            cur = m.group(1)
            continue
        mm = re.match(r'^\s*model:\s*(?:openai/|anthropic/)?(\S+)\s*$', l)
        if mm and cur and mm.group(1) == litellm_name:
            for j in range(i + 1, min(i + 30, len(lines))):
                mw = re.match(r'^(\s*)weight:\s*(\d+)\s*$', lines[j])
                if mw:
                    hits.append((cur, j + 1, mw.group(2)))
                    break
                if re.match(r'^\s*-\s*model_name:', lines[j]):
                    break
    return hits

for name in ['wbi-dsv4.1f', 'wb-step5', 'wb-hy3', 'deepseek-v4.1-flash',
             'deepseek-v4-flash', 'agnes-3.0-flash', 'qwen3.8-flash',
             'deepseek-v4.1-flash-intl']:
    h = probe(name)
    print(name.ljust(26), '->', ', '.join(f'{a}@L{b}(w={c})' for a, b, c in h) if h else '(no match)')
