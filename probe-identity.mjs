#!/usr/bin/env node
// 身份句指纹探针 —— 上游 11128「Illegal API invocation from an unapproved channel」定位用。
//
// 背景（2026-10-20）：WorkBuddy 上游对**已知第三方 agent 的身份首句**做黑名单拦截，
// 报错伪装成"渠道验证没过"，实际是提示词内容命中。黑名单会持续加条目，所以配这个探针：
// 收到新的 11128 → 把可疑句子一条条丢进来 → 命中的那句加进 daemon.mjs 的 IDENTITY_SCRUBS。
//
// 用法（token 默认读 token.txt 第一行；模型默认 deepseek-v4.1-flash）：
//   node probe-identity.mjs "You are Claude Code, Anthropic's official CLI for Claude."
//   node probe-identity.mjs --model glm-5.3-flash --token <你的钥匙> "句子1" "句子2"
//
// 🔴 探针走的是 wb-shim（:18796），所以**已经在 IDENTITY_SCRUBS 表里的句子必然 PASS**
//    （它测的是"净化之后发给上游的内容"）。它真正的用途：拿到一句**新**的可疑句子时，
//    先探它是否被拦（此时表里还没有它 → 真话），命中了再加表。加完再探=验净化生效。
//
// 退出码：有任意一句被拦 → 1（方便接 CI/告警）；全放行 → 0。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.WB_SHIM_BASE || 'http://127.0.0.1:18796';

function defaultToken() {
  try {
    const line = readFileSync(join(HERE, 'token.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
    const bar = line.indexOf('|');
    return bar > 0 ? line.slice(bar + 1).trim() : line;
  } catch { return ''; }
}

const argv = process.argv.slice(2);
let model = 'deepseek-v4.1-flash';
let token = defaultToken();
let raw = false;
const sentences = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') model = argv[++i];
  else if (a === '--token') token = argv[++i];
  else if (a === '--raw') raw = true;
  else sentences.push(a);
}
if (!sentences.length) {
  console.error('用法: node probe-identity.mjs [--model M] [--token T] "system 句子" ...');
  process.exit(2);
}
if (!token) { console.error('没拿到 token（token.txt 为空且未传 --token）'); process.exit(2); }

async function probe(sysContent) {
  // --raw：走 /v1/messages（Anthropic 路由）——那条路由**不经净化层**，测的就是上游原话。
  // 不开 --raw 走 /v1/chat/completions，测的是"净化之后"的内容（只会 PASS）。
  const url = raw ? `${BASE}/v1/messages` : `${BASE}/v1/chat/completions`;
  const payload = raw
    ? { model, max_tokens: 2, system: sysContent, messages: [{ role: 'user', content: 'hi' }] }
    : {
        model,
        messages: [{ role: 'system', content: sysContent }, { role: 'user', content: 'hi' }],
        stream: false,
        max_completion_tokens: 2,
      };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (res.status === 200) return { ok: true, detail: 'PASS' };
  const code = (text.match(/"code"\s*:\s*"?(\d+)"?/) || [])[1] || '';
  const blocked = code === '11128' || /unapproved channel/i.test(text);
  return { ok: false, detail: `${blocked ? 'BLOCK-11128' : `HTTP${res.status}`} ${text.slice(0, 160).replace(/\s+/g, ' ')}` };
}

let anyBlocked = false;
for (const s of sentences) {
  const r = await probe(s);
  if (!r.ok) anyBlocked = true;
  console.log(`${r.ok ? '✅' : '❌'} ${r.detail}\n   ${JSON.stringify(s).slice(0, 160)}`);
  // 命中后顺手给"去掉哪句能过"的建议
}
console.log(`\n模型=${model} 通道=${BASE} 命中拦截=${anyBlocked ? '有' : '无'}`);
process.exitCode = anyBlocked ? 1 : 0;

