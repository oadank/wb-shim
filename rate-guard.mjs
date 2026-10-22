#!/usr/bin/env node
/**
 * rate-guard.mjs —— 限流恢复调度器（2026-10-18 改版，老大定）
 *
 * 背景：检测改靠「真实流量」——daemon 代理转发只要吃到 429 就实时写 .rate-guard-state.json
 *   （账号:模型 + 官方重置时间），第一手、零额外探测。本服务不再每 5 分钟全量定时探
 *   （老大：定时探有被官方判刷分的风险）。
 *
 * 职责（只做「到点恢复」）：
 *   1. 定期读盘合并新写进来的限流（读本地文件，不打官方）
 *   2. 睡到最早的 resetAt，到点只复测那几个已知限流的模型
 *   3. 复探 200 = 解限 → 写状态 + 记「恢复」事件（网站随后读最新状态）
 *   4. 复探仍 429 = 没恢复 → 更新 resetAt 重新排；429 复探确认防瞬时误报
 *   5. 无 resetAt 的（超时/瞬时）兜底 IDLE_RETRY 后再复测
 *
 * 运行：nssm 服务 rate-guard
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, readJsonSafe, writeJsonSafe } from './events.mjs';
import { acctLabel, accountsForModelGroup } from './accounts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'rate-guard.json');
const STATE_FILE = process.env.RATE_GUARD_STATE || join(HERE, '.rate-guard-state.json');
const IDLE_MS = Number(process.env.RATE_GUARD_IDLE_MS || 60_000);                 // 空闲读盘间隔（本地，不打官方）
const IDLE_RETRY_MS = Number(process.env.RATE_GUARD_IDLE_RETRY_MS || 10 * 60 * 1000); // 无 resetAt 兜底复测间隔
// 🔴 [2026-10-21 11:30 老大拍板·止血] 定期主动探测**默认全关**。
// 起因：副号（N5105）被官方回 400 code=11140「账号存在异常行为，已被限制使用」——
// 02:44 起 4 个受管模型全探到该错误，而哨兵还在每 10 分钟往被封账号上撞。
// 老大原话「难道是我们的探测造成的，那得关闭探测啊」。10-18 就该做的事拖到今天。
// 关掉后：
//   - 限流信号只来自**真实流量**（daemon 代理转发吃到 429 时写状态，第一手零额外请求）
//   - 已标记 rate-limited 的到点复测**保留**（那是解限确认，不是主动招惹）
//   - 要临时开回：RATE_GUARD_PROBE_ENABLED=1 + 重启 rate-guard
const PROBE_ENABLED = String(process.env.RATE_GUARD_PROBE_ENABLED ?? '0') === '1';
// 定期轻探测间隔（仅 PROBE_ENABLED=1 时生效）
const PROBE_INTERVAL_MS = Number(process.env.RATE_GUARD_PROBE_INTERVAL_MS || 10 * 60 * 1000);
const REST_AFTER_OK_MS = Number(process.env.RATE_GUARD_REST_MS || 60 * 60 * 1000);
const PROBE_TIMEOUT_MS = Number(process.env.RATE_GUARD_TIMEOUT_MS || 60_000);
const SLOW_TIMEOUT_MS = Number(process.env.RATE_GUARD_SLOW_TIMEOUT_MS || 180_000);
const SLOW = new Set(['step-5-preview', 'step-5-preview-intl']);
function timeoutFor(group) { return SLOW.has(group) ? SLOW_TIMEOUT_MS : PROBE_TIMEOUT_MS; }

const log = (...a) => console.log(new Date().toISOString(), '[rate-guard]', ...a);

const WB_SHIM = process.env.WB_SHIM_URL || 'http://127.0.0.1:18796';
const WB_TOKEN_FILE = join(HERE, 'token.txt');
// [2026-10-21 修·国际版限流一整晚不解除的根因] token.txt 是「名字|token」多行格式：
//   cn|lc-xxx
//   intl|in-xxx
// 旧实现 readFileSync(...).trim() 把整个文件当一把 key（含换行+第二行），
// 而且 tokenFor 让国际版也用「本机 key」——三把钥匙分账号后国际版必须用 in 钥匙，
// 否则被 wb-shim 账号边界硬闸判 404 "not available for this token"。
// 404 既不算恢复(200)也不算限流(429) ⇒ 状态永远卡死。
function parseTokens() {
  const out = { cn: '', intl: '' };
  let raw = '';
  try { raw = readFileSync(WB_TOKEN_FILE, 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const bar = line.indexOf('|');
    if (bar > 0) {
      const name = line.slice(0, bar).trim().toLowerCase();
      const tok = line.slice(bar + 1).trim();
      if (name && tok && out[name] === '') out[name] = tok;
    } else if (out.cn === '') {
      out.cn = line; // 老格式：单行裸 token 视作国内钥匙
    }
  }
  return out;
}
let wbTokens = null;
function getTokens() { if (!wbTokens) wbTokens = parseTokens(); return wbTokens; }
function getWbToken() { return getTokens().cn; }
function getIntlToken() { return (process.env.WB_SHIM_INTL_TOKEN || '').trim() || getTokens().intl; }
// 账号 → 对应钥匙：国内 workbuddy→cn、国际 workbuddy-ai→intl。
// 两把钥匙必须一一对应——wb-shim 有账号边界硬闸，拿错钥匙打别的账号模型会 404。
function tokenFor(acct) {
  if (acct === 'workbuddy-ai') return getIntlToken();
  return getWbToken();
}
// 账号显示名/账号维度判定统一走 ./accounts.mjs 唯一真源（2026-10-19 收口，禁止各写一遍）
const labelFor = acctLabel;
const accountsFor = accountsForModelGroup;

async function probe(token, group) {
  if (!token) return { ok: false, skip: true, reason: '该账号无 token' };
  try {
    const r = await fetch(`${WB_SHIM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: group, messages: [{ role: 'user', content: '1' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(timeoutFor(group)),
    });
    const text = await r.text();
    if (r.status === 200) return { ok: true };
    if (r.status === 429 || /soft_rate/.test(text)) {
      return { ok: false, rateLimited: true, resetAt: parseResetAt(text), reason: extractMsg(text) };
    }
    return { ok: false, rateLimited: false, reason: `上游 HTTP ${r.status}: ${extractMsg(text)}` };
  } catch (e) {
    const timedOut = /timeout|aborted/i.test(String(e));
    return { ok: false, rateLimited: false, timedOut, reason: `探测异常: ${String(e).slice(0, 120)}` };
  }
}

function parseResetAt(text) {
  const t = String(text || '');
  const m = t.match(/([\d]{4}-[\d]{2}-[\d]{2})[\s T]+([\d]{2}:[\d]{2}:[\d]{2})\s*(?:UTC\+8|GMT\+8)?/);
  if (!m || !/重置|reset/i.test(t)) return null;
  const d = new Date(`${m[1]}T${m[2]}+08:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function extractMsg(text) {
  try {
    const j = JSON.parse(text);
    const raw = j?.error?.message || j?.message || text;
    const m = String(raw).match(/soft_rate[^"]*?(?:重置|reset)[^"]*?/i);
    return (m ? m[0] : String(raw)).slice(0, 200);
  } catch { return String(text).slice(0, 200); }
}
function fmtTime(ms) {
  if (!ms) return '未知时间';
  const d = new Date(ms);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 迁移：旧 per-model 键（无冒号）→ workbuddy:model（视为本机账号）
function migrate(state) {
  for (const k of Object.keys(state)) {
    if (k.indexOf(':') < 0) {
      state['workbuddy:' + k] = Object.assign({}, state[k], { account: 'workbuddy', model: k });
      delete state[k];
    }
  }
}
// 读盘合并：daemon 代理 429 会实时写状态进来，按 at 时间戳合并。
// 🔴 [2026-10-19 修] 必须双向：磁盘上已不存在的键要把内存里的一并删掉。
// 旧实现只加不删 ⇒ 人工/外部清理掉的脏键，每轮 writeJsonSafe 又原样写回磁盘
// （实测：删 workbuddy:step-5-preview-intl，60 秒后自己复活，必须重启本服务才清掉）。
// 现在以磁盘为权威：内存有、磁盘没有 → 删内存；两边都有 → 取 at 较新的。
function mergeDisk(state) {
  try {
    const disk = readJsonSafe(STATE_FILE, {});
    migrate(disk);
    for (const k of Object.keys(state)) {
      if (!(k in disk)) delete state[k];
    }
    for (const [k, st] of Object.entries(disk)) {
      if (st && (st.at || 0) > (state[k]?.at || 0)) state[k] = st;
    }
  } catch { /* 磁盘坏/被删：按内存继续 */ }
}

// 到点复测一个已知限流，解限则写状态 + 记恢复事件
async function reprobe(key, st) {
  const idx = key.indexOf(':');
  const acct = idx > 0 ? key.slice(0, idx) : 'workbuddy';
  const model = idx > 0 ? key.slice(idx + 1) : key;
  const label = labelFor(acct);
  const token = tokenFor(acct);
  let p = await probe(token, model);
  if (p.skip) return;
  // [2026-10-19 老大钦定：首探 429 即标记] 复测同理——不再要求"复探两次确认"。
  // 复测仍 429 = 没恢复；复测 200 = 解限。误报由 10 分钟周期的再次探测自然纠正。
  const now = Date.now();
  if (p.ok) {
    const downFor = st.since ? Math.round((now - st.since) / 60000) : null;
    st.status = 'ok'; st.resetAt = null; st.since = null; st.at = now;
    // 解限后歇 1 小时再恢复定期探测（避免刚解就探、白烧额度）
    st.nextProbeAt = now + REST_AFTER_OK_MS;
    log(`${key}（${label}）已恢复（限了约 ${downFor == null ? '?' : downFor} 分钟），${Math.round(REST_AFTER_OK_MS / 60000)} 分钟后再探`);
    appendEvent('rate-recovered', { model, group: model, account: acct, accountLabel: label, downForMin: downFor });
  } else if (p.rateLimited) {
    st.resetAt = p.resetAt ?? null; st.at = now;
    // 429 带官方重置时间 → 下次探测直接改到重置点；没时间就按兜底间隔
    st.nextProbeAt = p.resetAt ?? (now + IDLE_RETRY_MS);
    log(`${key}（${label}）到点仍限流${p.resetAt ? '，重置≈' + fmtTime(p.resetAt) : '（无官方时间）'}`);
  } else if (/not available for this token|unauthorized|401|403/i.test(String(p.reason || ''))) {
    // [2026-10-21 修·关键] 账号边界/鉴权类报错（404 not available for this token / 401）
    // 说明"这把钥匙探测不到这个模型"，**不是限流**。以前这种情况只更新时间、状态永远卡在
    // rate-limited（国际版实测从 10-20 11:45 卡到 10-21 10:57 一整晚）。
    // 处理：判为 ok 并记一条明确原因，让页面别再挂着假限流；同时把错误写进 st.reason 供排查。
    const wasLimited = st.status === 'rate-limited';
    const downFor = (wasLimited && st.since) ? Math.round((now - st.since) / 60000) : null;
    st.status = 'ok'; st.at = now; st.since = null; st.resetAt = null;
    st.nextProbeAt = now + IDLE_RETRY_MS;
    st.reason = `探测无效（钥匙/账号边界不匹配，非限流）：${String(p.reason || '').slice(0, 160)}`;
    log(`${key}（${label}）探测无效（非限流，判为正常）：${p.reason}`);
    if (wasLimited) {
      appendEvent('rate-recovered', { model, group: model, account: acct, accountLabel: label, downForMin: downFor });
      log(`${key}（${label}）原限流记录已解除（此前是探测错误造成的假限流）`);
    }
  } else {
    st.at = now; st.nextProbeAt = now + IDLE_RETRY_MS;
    log(`${key}（${label}）复测异常：${p.reason}`);
  }
}

async function tick(state) {
  mergeDisk(state);
  // 注册表齐全：受管组 × 账号，保证每个组合都有状态条目、都会进入探测循环
  try {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    for (const g of cfg.groups ?? []) {
      for (const acct of accountsFor(g.group)) {
        const key = acct.key + ':' + g.group;
        if (!state[key]) state[key] = { account: acct.key, model: g.group, status: 'ok', at: 0 };
      }
    }
  } catch { /* 配置读失败：按现有 state 继续 */ }
  // 🔴 [2026-10-19 清脏键] 只保留「配置受管组 × 合法账号」的键。
  // 背景：/api/rate-state 曾把 -intl 模型记到 workbuddy（国内版）头上（旧代码写死
  // 'workbuddy:'），产生 workbuddy:step-5-preview-intl 这种脏键；它不在注册表里，
  // 旧逻辑每轮 writeJsonSafe(state) 原样写回磁盘 ⇒ 人工删了 60 秒又复活。
  // 现在：每次 tick 先按白名单清洗，脏键立删，并且不再写回。
  try {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const valid = new Set();
    for (const g of cfg.groups ?? []) {
      for (const acct of accountsFor(g.group)) {
        valid.add(acct.key + ':' + g.group);
      }
    }
    for (const k of Object.keys(state)) {
      // 只有带冒号的 account:model 键受管辖；无冒号的老键交给 migrate() 处理
      if (k.includes(':') && !valid.has(k)) {
        log(`清掉不合法状态键：${k}（不在受管组×账号白名单）`);
        delete state[k];
      }
    }
  } catch { /* 配置读失败：不清洗，保守保留 */ }
  const now = Date.now();
  for (const [key, st] of Object.entries(state)) {
    if (!st.model) continue;
    const acct = st.account || key.slice(0, key.indexOf(':'));
    const label = labelFor(acct);
    const token = tokenFor(acct);
    if (st.status === 'rate-limited') {
      if (st.resetAt && st.resetAt > now) continue;   // 等官方重置点，到点自动复测
      await reprobe(key, st);                          // 到点复测（解限则写恢复 + 歇 1 小时）
      continue;
    }
    // 正常态：解限后歇 1 小时；否则每 PROBE_INTERVAL_MS 轻探一次（max_tokens=1）
    // 🔴 [2026-10-21 老大定] PROBE_ENABLED=0（默认）：不主动探，只等真实流量 429。
    if (st.nextProbeAt && now < st.nextProbeAt) continue;
    if (!PROBE_ENABLED) continue;               // 关探测：本 tick 一个官方请求都不发
    if (st.at && now - st.at < PROBE_INTERVAL_MS) continue;
    let p = await probe(token, st.model);
    if (p.skip) continue;
    // [2026-10-19 老大钦定：首探 429 即标记]
    // 取代 10-17 的「首探 429 必须复探确认 + 必须带官方重置时间」——
    // 那套防误报规矩把国际版的限流全挡了（实测：hy3-intl / deepseek-…-intl 反复探到 429，
    // 每次都被判"瞬时抖动不标记"或"无官方重置时间不标记" ⇒ 老大看到限流、页面永远不显示）。
    // 现在：探到 429 就标记 + 记事件；误报风险交给已有的「到点复测」兜底
    // （reprobe 仍 429 ⇒ 更新 resetAt 重排；复探 200 ⇒ 记恢复 + 歇 1 小时）。
    // 注：无官方重置时间的 429 也标记，resetAt 留 null，页面显"官方时间待确认"，
    //     哨兵按 IDLE_RETRY_MS（10 分钟）后自动复测——比漏报好。
    const t = Date.now();
    if (p.ok) { st.status = 'ok'; st.at = t; st.timeouts = 0; st.nextProbeAt = 0; continue; }
    if (p.rateLimited) {
      const isNew = st.status !== 'rate-limited';
      st.status = 'rate-limited'; st.resetAt = p.resetAt ?? null; st.since = t; st.at = t; st.reason = p.reason; st.source = 'probe';
      st.nextProbeAt = p.resetAt ?? (t + IDLE_RETRY_MS); // 有官方重置点就排到点，否则 10 分钟后再看
      if (isNew) appendEvent('rate-limited', { model: st.model, group: st.model, account: acct, accountLabel: label, reason: p.reason, resetAt: p.resetAt ?? null, resetAtText: p.resetAt ? fmtTime(p.resetAt) : null, source: 'probe' });
      log(`${key}（${label}）撞限流${p.resetAt ? '，' + fmtTime(p.resetAt) + ' 到点自动复测' : '（无官方重置时间，10 分钟后自动复测）'}`);
      continue;
    }
    // 超时/异常：连续 3 次判挂死（无官方时间，兜底 IDLE_RETRY 后复测）
    st.timeouts = (st.timeouts || 0) + 1;
    st.at = t;
    if (p.timedOut && st.timeouts >= 3) {
      st.status = 'rate-limited'; st.resetAt = null; st.since = t; st.reason = '连续超时（疑似挂死）'; st.source = 'probe';
      st.nextProbeAt = t + IDLE_RETRY_MS;
      log(`${key}（${label}）连续 3 次超时 ⇒ 判定挂死，兜底稍后复测`);
    } else {
      st.nextProbeAt = t + IDLE_RETRY_MS;
      log(`${key}（${label}）探测异常（${st.timeouts}）：${p.reason}`);
    }
  }
  writeJsonSafe(STATE_FILE, state);
  // 睡到下一个待办（最早 nextProbeAt/resetAt），最长不超过 IDLE_MS（保证定期读盘捡真实流量新限流）
  let next = Infinity;
  for (const st of Object.values(state)) {
    const t = (st.nextProbeAt && st.nextProbeAt > Date.now()) ? st.nextProbeAt
      : (st.status === 'rate-limited' && st.resetAt && st.resetAt > Date.now()) ? st.resetAt : 0;
    if (t > Date.now()) next = Math.min(next, t);
  }
  let sleep = IDLE_MS;
  if (next !== Infinity) sleep = Math.min(sleep, Math.max(next - Date.now() + 2000, 1000));
  return sleep;
}

let stopping = false, wake = null, timer = null;
function sleep(ms) {
  return new Promise((resolve) => {
    wake = resolve;
    // 🔴 不能 unref()：unref 的 timer 不阻止进程退出
    timer = setTimeout(() => { wake = null; timer = null; resolve(); }, ms);
  });
}

async function main() {
  const state = readJsonSafe(STATE_FILE, {});
  migrate(state);
  log(`启动：限流哨兵（主动探测已${PROBE_ENABLED ? '开' : '关'}——只靠真实流量 429 捕获；已标记的到点复测保留；解限歇 ${REST_AFTER_OK_MS / 60000} 分钟；空闲每 ${IDLE_MS / 1000}s 读盘）`);
  while (!stopping) {
    try { const ms = await tick(state); await sleep(ms); }
    catch (e) { log('本轮异常:', String(e).slice(0, 200)); await sleep(IDLE_MS); }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号');
    stopping = true;
    if (timer) clearTimeout(timer);
    if (wake) { const w = wake; wake = null; w(); }
  });
}
process.on('uncaughtException', (e) => log('uncaughtException 兜底:', e?.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandledRejection 兜底:', e?.stack || String(e)));

main().catch((e) => { console.error('[rate-guard] 致命:', e); process.exit(1); });
