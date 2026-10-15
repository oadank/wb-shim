#!/usr/bin/env node
/**
 * rate-guard.mjs —— 限流感知自动重排（2026-10-14 老大钦定"方案3 治本"）
 *
 * 解决什么：免费模型也会被限流（"workbuddy upstream soft_rate http 429"），
 * 而且**限流是按「账号+模型」维度算的**——同一个免费源挂的 bot 越多撞得越快。
 * 之前的痛点是撞限流只能靠人肉发现，这个服务自动处理：
 *
 *   1. 探针：每 5 分钟对每个受管组打一发最小请求（max_tokens=1）
 *   2. 撞限流（soft_rate 429）→ 解析重置时间 → 把该组 bot 挪到备用组
 *   3. 到重置时间 → 探测恢复 → 把 bot 挪回原组
 *   4. 全程私聊老大（人话：哪个组限流了、几个 bot 挪去哪、什么时候回）
 *
 * 配置：rate-guard.json（受管组 + 各组挂的 bot + 备用组顺序）
 * 运行：nssm 服务 rate-guard
 *
 * 🔴 铁律：挪 bot 走配置中心 API（PUT /api/agents/<id>），幂等可重放；
 *   挪之前先确认目标组可用（探针通），不通就试下一个备用组——绝不把 bot 挪进坑里。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordNotify } from './notify-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'rate-guard.json');
const STATE_FILE = process.env.RATE_GUARD_STATE || join(HERE, '.rate-guard-state.json');
const LITELLM = 'http://127.0.0.1:4000';
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY || 'sk-CHANGEME';
const CONFIG_CENTER = process.env.CONFIG_CENTER || 'http://127.0.0.1:13600';
const PROBE_MS = Number(process.env.RATE_GUARD_PROBE_MS || 5 * 60 * 1000); // 5 分钟
const PROBE_TIMEOUT_MS = Number(process.env.RATE_GUARD_TIMEOUT_MS || 60_000);
// step-5 系列又慢又爱思考，max_tokens=1 也常要 20~40 秒；给它们单独更长的超时，
// 否则会被误判成"探测异常"（2026-10-14 实测踩过：wb-st5pin 40s 超时误报）。
const SLOW_GROUP_TIMEOUT_MS = Number(process.env.RATE_GUARD_SLOW_TIMEOUT_MS || 120_000);
const SLOW_GROUPS = new Set(['wb-st5pcn', 'wb-st5pin', 'wb-step5', 'wbi-step5']);
function timeoutFor(group) { return SLOW_GROUPS.has(group) ? SLOW_GROUP_TIMEOUT_MS : PROBE_TIMEOUT_MS; }

const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
const AT_OPEN_ID = process.env.LARK_ALERT_AT_OPEN_ID || 'ou_888b94e17b7d3d6dcc21ddbc6b35abb4';

const log = (...a) => console.log(new Date().toISOString(), '[rate-guard]', ...a);

// ── 飞书私聊（与 alert-push 同通道）─────────────────
let tokenCache = { token: '', at: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() - tokenCache.at < 90 * 60 * 1000) return tokenCache.token;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`token 失败: ${j.code} ${j.msg}`);
  tokenCache = { token: j.tenant_access_token, at: Date.now() };
  return j.tenant_access_token;
}
async function sendText(text, kind = 'rate-limit', meta) {
  const token = await getToken();
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: AT_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`发消息失败: ${j.code} ${j.msg}`);
  // 记历史（看板展示用）——放在发送成功之后
  recordNotify('rate-guard', kind, text, meta);
  return j.data?.message_id;
}

// ── 探测：直探 wb-shim 上游，绕过 litellm 的 fallback ──
// 🔴 为什么不能经 litellm 探：litellm 的 fallback 链会在上游 429 后自动降级到备用组
// 并返回 200，探针看到的永远是"成功"，检测不到真限流（2026-10-14 实测踩过）。
// 所以直接打 wb-shim（:18796）用上游模型名探，才能拿到真实的 soft_rate 429。
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
    'wb-dsv4.1fin': 'deepseek-v4.1-flash-intl',   // 旧名（10-14 改名前），保留防旧 state
    'wbi-dsv4.1fi': 'deepseek-v4.1-flash-intl',   // [2026-10-15] 新名
    'wb-st5pcn': 'step-5-preview',
    'wb-st5pin': 'step-5-preview-intl',
    'wb-hy3': 'hy3-intl',
    'wb-hy3cn': 'hy3',
    'wb-step5': 'step-5-preview',
    'wb-glm5.3f': 'glm-5.3-flash',
    'wb-hy4-preview': 'hy4-preview',              // [2026-10-15] 补 hermes 独占组
    'wb-hy4-preview-intl': 'hy4-preview',
  };
  return map[group] || null;
}

async function probe(group) {
  const upstream = upstreamOf(group);
  // 有上游映射的组：直探 wb-shim（能发现被 fallback 掩盖的限流）
  // 没有的（claude-sonnet-4-5/codex-model/DV4F 等非 wb 组）：退回经 litellm 探
  if (upstream) {
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
      // 🔴 [2026-10-15] 超时≠"非限流"：Step5 系模型撞墙时表现为无限挂起直到超时，
      // 永远轮不到 429（实测 step-5-preview 国内版 150s 超时）。单独标 timedOut，
      // 由 checkOnce 按"连续 N 次超时=撞墙"处理，不再放任不管。
      const timedOut = /timeout|aborted/i.test(String(e));
      return { ok: false, rateLimited: false, timedOut, reason: `探测异常: ${String(e).slice(0, 120)}` };
    }
  }
  // 非 wb 组：经 litellm 探
  try {
    const r = await fetch(`${LITELLM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LITELLM_KEY}` },
      body: JSON.stringify({ model: group, messages: [{ role: 'user', content: '1' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(timeoutFor(group)),
    });
    const text = await r.text();
    if (r.status === 200) return { ok: true };
    if (r.status === 429 || /soft_rate/.test(text)) {
      return { ok: false, rateLimited: true, resetAt: parseResetAt(text), reason: extractMsg(text) };
    }
    return { ok: false, rateLimited: false, reason: `litellm HTTP ${r.status}: ${extractMsg(text)}` };
  } catch (e) {
    const timedOut = /timeout|aborted/i.test(String(e));
    return { ok: false, rateLimited: false, timedOut, reason: `探测异常: ${String(e).slice(0, 120)}` };
  }
}

/**
 * 从报错文本里抠出重置时间。中英文都要认（2026-10-14 踩坑：国际账号报错是英文
 * "usage will reset at 2026-10-14 18:39:02 UTC+8"，只认中文会漏成"未知时间"）。
 * 中文：将在 2026-10-14 17:17:03 UTC+8 重置
 * 英文：your usage will reset at 2026-10-14 18:39:02 UTC+8
 */
function parseResetAt(text) {
  // 中英文统一：找 "YYYY-MM-DD HH:MM:SS" 日期串 + 前后的限流语境词
  const re = /([\d]{4}-[\d]{2}-[\d]{2})[\s T]+([\d]{2}:[\d]{2}:[\d]{2})\s*(?:UTC\+8|GMT\+8)?/;
  const m = text.match(re);
  if (!m) return null;
  // 只有报错文本里带"重置/reset"才认为这是重置时间（防误抓别的日期）
  if (!/重置|reset/i.test(text)) return null;
  const d = new Date(`${m[1]}T${m[2]}+08:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function extractMsg(text) {
  try {
    const j = JSON.parse(text);
    const raw = j?.error?.message || j?.message || text;
    // 中英文都抓：soft_rate 后面到"重置/reset"为止的核心句
    const m = String(raw).match(/soft_rate[^"]*?(?:重置|reset)[^"]*?/i);
    return (m ? m[0] : String(raw)).slice(0, 200);
  } catch { return text.slice(0, 200); }
}
function fmtTime(ms) {
  if (!ms) return '未知时间';
  const d = new Date(ms);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 配置中心：挪 bot ────────────────────────────────
async function moveBot(botId, modelId) {
  const r = await fetch(`${CONFIG_CENTER}/api/agents/${botId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`挪 ${botId} 失败: HTTP ${r.status}`);
  const j = await r.json();
  if (j.modelId !== modelId) throw new Error(`挪 ${botId} 后回读不符: ${j.modelId}`);
  return true;
}
/** 读某 bot 当前 modelId */
async function botModel(botId) {
  try {
    const r = await fetch(`${CONFIG_CENTER}/api/agents/${botId}`, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    return j.modelId;
  } catch { return null; }
}

// ── 状态 ────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { log('状态写盘失败:', String(e)); }
}

/** 读配置中心，返回当前真实挂在某组上的 bot 列表 */
async function botsOnGroup(group) {
  try {
    const r = await fetch(`${CONFIG_CENTER}/api/agents`, { signal: AbortSignal.timeout(15_000) });
    const list = await r.json();
    return (Array.isArray(list) ? list : [])
      .filter((a) => a.providerId === 'litellm' && a.modelId === group)
      .map((a) => a.id);
  } catch (e) {
    log(`读配置中心失败（本轮跳过 ${group}）:`, String(e).slice(0, 120));
    return null;
  }
}

// ── 主逻辑 ─────────────────────────────────────────
let stopping = false;
let wake = null, timer = null;

async function checkOnce(state) {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  for (const g of cfg.groups ?? []) {
    const st = state[g.group] || (state[g.group] = { status: 'ok' });
    const now = Date.now();

    // 已被挪走：等重置时间到了再探测恢复
    if (st.status === 'moved') {
      if (st.resetAt && now < st.resetAt) continue; // 还没到重置时间
      const p = await probe(g.group);
      if (p.ok) {
        // 恢复了 → 把 bot 挪回原组
        const back = [];
        for (const b of (st.moved ?? [])) {
          try { await moveBot(b, g.group); back.push(b); } catch (e) { log(`挪回 ${b} 失败:`, String(e).slice(0, 120)); }
        }
        st.status = 'ok'; st.resetAt = null; st.moved = [];
        log(`${g.group} 已恢复，${back.length} 个 bot 挪回`);
        try { await sendText(`✅ 限流解除：${g.group}（${upstreamOf(g.group) || g.group}）已恢复，${back.join('、')} 共 ${back.length} 个 bot 已自动挪回原组，恢复正常。`, 'rate-recovered', { group: g.group, bots: back }); } catch {}
      } else {
        log(`${g.group} 重置时间到了但仍未恢复：${p.reason}`);
        st.resetAt = p.resetAt || (now + 30 * 60 * 1000); // 再等 30 分钟
      }
      continue;
    }

    // 正常态：探测
    const p = await probe(g.group);
    if (p.ok) { st.status = 'ok'; st.timeouts = 0; continue; }
    // 🔴 [2026-10-15 修 Step5 检测不到] 探测超时≠没事：Step5 系撞墙表现为无限挂起
    // 直到超时（实测 150s），永远轮不到 429。连续 TIMEOUT_STRIKES 次（默认 3 次=15 分钟
    // 持续挂死）就按撞墙处理，走与 429 相同的挪 bot 流程。恢复探测仍走原逻辑。
    const TIMEOUT_STRIKES = Number(process.env.RATE_GUARD_TIMEOUT_STRIKES || 3);
    if (p.timedOut) {
      st.timeouts = (st.timeouts || 0) + 1;
      if (st.timeouts < TIMEOUT_STRIKES) {
        log(`${g.group} 探测超时 ${st.timeouts}/${TIMEOUT_STRIKES} 次，暂不挪（连续 ${TIMEOUT_STRIKES} 次才判定挂死）：${p.reason}`);
        continue;
      }
      log(`${g.group} 连续 ${TIMEOUT_STRIKES} 次探测超时 ⇒ 判定上游挂死，按撞墙处理`);
      // 复用限流处理流程：伪造成一次"撞墙"事件往下走（resetAt 给 30 分钟后再探）
      p.rateLimited = true;
      p.resetAt = now + 30 * 60 * 1000;
    } else {
      st.timeouts = 0;
    }
    if (!p.rateLimited) { log(`${g.group} 探测异常（非限流，不挪）：${p.reason}`); continue; }

    // 🔴 撞限流 → 运行时读配置中心，拿"真实挂在本组上的 bot"（不靠配置文件写死，
    // 避免手动调整分组后名单脱节——2026-10-14 实测踩过：配置里 bots 为空导致挪 0 个）
    const victims = await botsOnGroup(g.group);
    if (victims === null) { log(`${g.group} 限流但读不到 bot 名单，下轮重试`); continue; }
    if (!victims.length) {
      log(`${g.group} 撞限流但当前无 bot 挂载（可能已手动切走），记状态不挪`);
      st.status = 'moved'; st.movedTo = null; st.moved = []; st.resetAt = p.resetAt;
      continue;
    }

    log(`${g.group} 撞限流：${p.reason}（${victims.length} 个 bot 受影响）`);
    let target = null;
    for (const alt of g.fallbacks ?? []) {
      const ap = await probe(alt);
      if (ap.ok) { target = alt; break; }
      log(`  备用组 ${alt} 不可用，试下一个`);
    }
    if (!target) {
      log(`${g.group} 无可用备用组，不挪（避免挪进坑里）`);
      try { await sendText([
        `🚨 ${g.group} 撞频率限制，所有备用组也不可用，${victims.length} 个 bot 没法自动救：`,
        `受影响：${victims.join('、')}`,
        `限额解除时间：${fmtTime(p.resetAt)}`,
        `请人工看（bot 会先走 litellm 的 fallback 链硬撑，但可能降级到付费腿）。`,
      ].join('\n'), 'rate-no-target', { group: g.group, bots: victims, resetAt: p.resetAt }); } catch {}
      st.status = 'fail'; st.resetAt = p.resetAt;
      continue;
    }
    const moved = [];
    for (const b of victims) {
      try { await moveBot(b, target); moved.push(b); } catch (e) { log(`挪 ${b} 失败:`, String(e).slice(0, 120)); }
    }
    st.status = 'moved'; st.movedTo = target; st.moved = moved; st.resetAt = p.resetAt;
    log(`${g.group} → ${target}，已挪 ${moved.length}/${victims.length}`);
    try {
      const upstreamName = upstreamOf(g.group) || g.group;
      await sendText([
        `⚡ 限流救火：${upstreamName} 撞频率限制（免费也有限额）`,
        `限额解除时间：${fmtTime(p.resetAt)}`,
        `已自动挪走：${moved.join('、')} 共 ${moved.length} 个 bot → ${target} 顶上`,
        `到解除时间后我会自动把 bot 挪回，你不用管。`,
      ].join('\n'), 'rate-moved', { group: g.group, upstream: upstreamName, movedTo: target, bots: moved, resetAt: p.resetAt });
    } catch {}
  }
}

async function main() {
  if (!APP_ID || !APP_SECRET) { console.error('[rate-guard] 缺 LARK 凭据，退出'); process.exit(1); }
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  log(`启动：受管 ${cfg.groups.length} 组，每 ${PROBE_MS / 1000}s 探一次`);
  const state = loadState();
  while (!stopping) {
    try { await checkOnce(state); saveState(state); }
    catch (e) { log('本轮异常:', String(e).slice(0, 200)); }
    await new Promise((resolve) => {
      wake = resolve;
      // 🔴 不能 unref()：unref 的 timer 不阻止进程退出，事件循环一空 node 就退了
      // （表现为服务起不来、exit=0、无报错）。2026-10-14 踩坑。
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
