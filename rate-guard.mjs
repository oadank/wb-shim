#!/usr/bin/env node
/**
 * rate-guard.mjs —— 限流哨兵（2026-10-15 瘦身版）
 *
 * 职责（老大拍板：wb-shim 自动化只做份内的事=维护主页模型信息准确及时）：
 *   1. 每 5 分钟对每个受管模型直探 wb-shim 上游（max_tokens=1）
 *   2. 撞限流（soft_rate 429）/ 连续超时挂死 → 记时间线事件 + 状态写盘（首页徽章读）
 *   3. 到重置时间探测恢复 → 记解除事件
 *
 * 已剥离（2026-10-15）：飞书私聊、挪 bot（配置中心）、litellm 探测——
 *   那些是老大机房里的下游编排，不属于本独立项目。需要通知走 hooks.json
 *   的通用 webhook（见 events.mjs）。
 *
 * 运行：nssm 服务 rate-guard
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, readJsonSafe, writeJsonSafe } from './events.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'rate-guard.json');
const STATE_FILE = process.env.RATE_GUARD_STATE || join(HERE, '.rate-guard-state.json');
const PROBE_MS = Number(process.env.RATE_GUARD_PROBE_MS || 5 * 60 * 1000);
const PROBE_TIMEOUT_MS = Number(process.env.RATE_GUARD_TIMEOUT_MS || 60_000);
// step-5 系又慢又爱思考，max_tokens=1 也常要 20~40 秒；单独更长超时防误判
//（2026-10-14 实测踩过：wb-st5pin 40s 超时误报）
const SLOW_GROUP_TIMEOUT_MS = Number(process.env.RATE_GUARD_SLOW_TIMEOUT_MS || 120_000);
const SLOW_GROUPS = new Set(['wb-st5pcn', 'wb-st5pin', 'wb-step5', 'wbi-step5']);
function timeoutFor(group) { return SLOW_GROUPS.has(group) ? SLOW_GROUP_TIMEOUT_MS : PROBE_TIMEOUT_MS; }

const log = (...a) => console.log(new Date().toISOString(), '[rate-guard]', ...a);

// ── 探测：直探 wb-shim 上游（拿真实 soft_rate 429，不被任何中间层 fallback 掩盖）──
const WB_SHIM = process.env.WB_SHIM_URL || 'http://127.0.0.1:18796';
const WB_TOKEN_FILE = join(HERE, 'token.txt');
let wbToken = '';
function getWbToken() {
  if (!wbToken) { try { wbToken = readFileSync(WB_TOKEN_FILE, 'utf8').trim(); } catch {} }
  return wbToken;
}

/** 组名 → 上游模型名（探针用真名打上游） */
function upstreamOf(group) {
  const map = {
    'wb-dsv4.1fin': 'deepseek-v4.1-flash-intl',
    'wbi-dsv4.1fi': 'deepseek-v4.1-flash-intl',
    'wb-st5pcn': 'step-5-preview',
    'wb-st5pin': 'step-5-preview-intl',
    'wb-hy3': 'hy3-intl',
    'wb-hy3cn': 'hy3',
    'wb-step5': 'step-5-preview',
    'wb-glm5.3f': 'glm-5.3-flash',
    'wb-hy4-preview': 'hy4-preview',
    'wb-hy4-preview-intl': 'hy4-preview',
  };
  return map[group] || null;
}

async function probe(group) {
  const upstream = upstreamOf(group);
  if (!upstream) return { ok: false, skip: true, reason: '无上游映射（非 wb 组），哨兵不探' };
  try {
    const r = await fetch(`${WB_SHIM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getWbToken()}` },
      body: JSON.stringify({ model: upstream, messages: [{ role: 'user', content: '1' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(timeoutFor(group)),
    });
    const text = await r.text();
    if (r.status === 200) return { ok: true };
    if (r.status === 429 || /soft_rate/.test(text)) {
      return { ok: false, rateLimited: true, resetAt: parseResetAt(text), reason: extractMsg(text) };
    }
    return { ok: false, rateLimited: false, reason: `上游 HTTP ${r.status}: ${extractMsg(text)}` };
  } catch (e) {
    // 🔴 超时≠"非限流"：Step5 系撞墙时表现为无限挂起直到超时，永远轮不到 429
    //（实测 step-5-preview 国内版 150s 超时）。标 timedOut 由 checkOnce 按
    // "连续 N 次超时=撞墙"处理。
    const timedOut = /timeout|aborted/i.test(String(e));
    return { ok: false, rateLimited: false, timedOut, reason: `探测异常: ${String(e).slice(0, 120)}` };
  }
}

/** 从报错文本抠重置时间（中英文都认：中文"将在 ... 重置"/英文 "usage will reset at ..."） */
function parseResetAt(text) {
  const re = /([\d]{4}-[\d]{2}-[\d]{2})[\s T]+([\d]{2}:[\d]{2}:[\d]{2})\s*(?:UTC\+8|GMT\+8)?/;
  const m = text.match(re);
  if (!m) return null;
  if (!/重置|reset/i.test(text)) return null;
  const d = new Date(`${m[1]}T${m[2]}+08:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function extractMsg(text) {
  try {
    const j = JSON.parse(text);
    const raw = j?.error?.message || j?.message || text;
    const m = String(raw).match(/soft_rate[^"]*?(?:重置|reset)[^"]*?/i);
    return (m ? m[0] : String(raw)).slice(0, 200);
  } catch { return text.slice(0, 200); }
}
function fmtTime(ms) {
  if (!ms) return '未知时间';
  const d = new Date(ms);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 主逻辑 ─────────────────────────────────────────
let stopping = false;
let wake = null, timer = null;

async function checkOnce(state) {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  for (const g of cfg.groups ?? []) {
    const st = state[g.group] || (state[g.group] = { status: 'ok' });
    const now = Date.now();

    // 已限流：等重置时间到了再探测恢复
    if (st.status === 'rate-limited') {
      if (st.resetAt && now < st.resetAt) continue;
      const p = await probe(g.group);
      if (p.ok) {
        st.status = 'ok'; st.resetAt = null;
        log(`${g.group} 已恢复`);
        appendEvent('rate-recovered', { model: upstreamOf(g.group) || g.group, group: g.group, downForMin: Math.round((now - (st.since || now)) / 60000) });
        st.since = null;
      } else {
        log(`${g.group} 重置时间到了但仍未恢复：${p.reason}`);
        st.resetAt = p.resetAt || (now + 30 * 60 * 1000);
      }
      continue;
    }

    // 正常态：探测
    const p = await probe(g.group);
    if (p.ok) { st.status = 'ok'; st.timeouts = 0; continue; }
    if (p.skip) continue;
    // 探测超时≠没事：Step5 系撞墙表现为无限挂起直到超时（实测 150s）。
    // 连续 TIMEOUT_STRIKES 次（默认 3 次=15 分钟持续挂死）判定撞墙。
    const TIMEOUT_STRIKES = Number(process.env.RATE_GUARD_TIMEOUT_STRIKES || 3);
    if (p.timedOut) {
      st.timeouts = (st.timeouts || 0) + 1;
      if (st.timeouts < TIMEOUT_STRIKES) {
        log(`${g.group} 探测超时 ${st.timeouts}/${TIMEOUT_STRIKES} 次，暂不判定：${p.reason}`);
        continue;
      }
      log(`${g.group} 连续 ${TIMEOUT_STRIKES} 次探测超时 ⇒ 判定挂死`);
      p.rateLimited = true;
      p.resetAt = now + 30 * 60 * 1000;
    } else {
      st.timeouts = 0;
    }
    if (!p.rateLimited) { log(`${g.group} 探测异常（非限流，只记日志）：${p.reason}`); continue; }

    // 撞限流/挂墙：记事件 + 状态（首页徽章/时间线渲染用），不再做任何下游编排
    st.status = 'rate-limited';
    st.since = now;
    st.resetAt = p.resetAt;
    log(`${g.group} 撞限流：${p.reason}（解除约 ${fmtTime(p.resetAt)}）`);
    appendEvent('rate-limited', {
      model: upstreamOf(g.group) || g.group,
      group: g.group,
      reason: p.reason,
      resetAt: p.resetAt,
      resetAtText: fmtTime(p.resetAt),
    });
  }
}

async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  log(`启动：限流哨兵盯 ${cfg.groups.length} 个模型，每 ${PROBE_MS / 1000}s 探一次（纯记录，不做下游编排）`);
  const state = readJsonSafe(STATE_FILE, {});
  while (!stopping) {
    try { await checkOnce(state); writeJsonSafe(STATE_FILE, state); }
    catch (e) { log('本轮异常:', String(e).slice(0, 200)); }
    await new Promise((resolve) => {
      wake = resolve;
      // 🔴 不能 unref()：unref 的 timer 不阻止进程退出（2026-10-14 踩坑）
      timer = setTimeout(() => { wake = null; timer = null; resolve(); }, PROBE_MS);
    });
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
