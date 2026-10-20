#!/usr/bin/env node
// 全部 bot 的身份句巡检（2026-10-20 老大令：把 12 个 bot 都探一遍，直接排除干净）。
//
// 干两件事：
//   1. 拿配置中心花名册（:13600/api/agents），把每个 bot 的**业务 systemPrompt** 原样丢给上游，
//      看是否命中 11128 身份句黑名单（这类拦截只认"身份句"，业务提示词一般不会被拦，但要证明，不能假设）。
//   2. 把各 runtime（claude / codex / dsh ...）的**内置身份首句**逐条丢给上游，确认哪些进了黑名单、
//      哪些没进——没进的要靠 wb-shim 的 IDENTITY_SCRUBS 兜住，进了的说明净化必须覆盖。
//
// 🔴 全部走 `--raw` 语义：直接打 /v1/messages（Anthropic 路由，不经净化层），
//    否则测出来永远是 PASS，等于自欺。
//
// 用法：node sweep-identity.mjs [--model deepseek-v4.1-flash] [--token <你的钥匙>]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.WB_SHIM_BASE || 'http://127.0.0.1:18796';
const CONFIG = process.env.DSH_CONFIG_CENTER || 'http://127.0.0.1:13600';

const argv = process.argv.slice(2);
let model = 'deepseek-v4.1-flash';
let token = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model') model = argv[++i];
  else if (argv[i] === '--token') token = argv[++i];
}
if (!token) {
  const line = readFileSync(join(HERE, 'token.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  const bar = line.indexOf('|');
  token = bar > 0 ? line.slice(bar + 1).trim() : line;
}

// 各 runtime 的**内置身份首句**（拿不到内置源码的就留空，宁缺勿编）
const RUNTIME_IDENTITY = {
  dsh: 'You are an AI agent powered by DeepSeek Harness.',
  claude: "You are Claude Code, Anthropic's official CLI for Claude.",
  codex: 'You are Codex, a coding agent based on GPT-5.',
};

async function rawProbe(sysContent) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, max_tokens: 2, system: sysContent, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (res.status === 200) return { ok: true };
  const blocked = /11128/.test(text) || /unapproved channel/i.test(text);
  return { ok: false, blocked, detail: text.slice(0, 140).replace(/\s+/g, ' ') };
}

const roster = await (await fetch(`${CONFIG}/api/agents`)).json();
const list = Array.isArray(roster) ? roster : (roster.agents || []);
console.log(`花名册 ${list.length} 家 | 模型 ${model} | 通道 ${BASE}（raw，经 /v1/messages）\n`);

const rows = [];
for (const a of list) {
  const sp = String(a.systemPrompt || '').trim();
  const name = a.id || a.displayName || '?';
  const runtime = a.runtime || '?';
  if (!sp) { rows.push({ name, runtime, verdict: '空提示词', note: '' }); continue; }
  const r = await rawProbe(sp);
  rows.push({
    name,
    runtime,
    verdict: r.ok ? 'PASS' : (r.blocked ? 'BLOCK-11128' : 'ERR'),
    note: r.ok ? `${sp.length} 字` : r.detail,
    len: sp.length,
  });
}

console.log('【1】各 bot 业务提示词（配置中心 systemPrompt）');
for (const r of rows) {
  console.log(`  ${r.verdict.padEnd(12)} ${r.name.padEnd(10)} runtime=${String(r.runtime).padEnd(10)} ${r.note}`);
}

console.log('\n【2】各 runtime 内置身份首句');
const byRuntime = {};
for (const r of rows) byRuntime[r.runtime] = (byRuntime[r.runtime] || 0) + 1;
for (const rt of Object.keys(byRuntime).sort()) {
  const sent = RUNTIME_IDENTITY[rt];
  if (!sent) { console.log(`  ?            ${rt.padEnd(10)} (${byRuntime[rt]} 家) 内置身份句未知，未探`); continue; }
  const r = await rawProbe(sent);
  console.log(`  ${(r.ok ? 'PASS' : (r.blocked ? 'BLOCK-11128' : 'ERR')).padEnd(12)} ${rt.padEnd(10)} (${byRuntime[rt]} 家) ${JSON.stringify(sent).slice(0, 80)}`);
}

const bad = rows.filter((r) => r.verdict !== 'PASS' && r.verdict !== '空提示词');
console.log(`\n结论：业务提示词被拦 ${bad.length} 家${bad.length ? ' -> ' + bad.map((b) => b.name).join(', ') : '（全部放行）'}`);
process.exitCode = bad.length ? 1 : 0;

