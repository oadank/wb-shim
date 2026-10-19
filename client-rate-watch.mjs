#!/usr/bin/env node
/**
 * client-rate-watch.mjs —— 客户端限流播报监听（CDP :9223 → wb-shim /api/rate-state）
 *
 * 背景（2026-10-17 老大拍板「两个合起来信号源全闭环，拦截官方播报」）：
 *   WorkBuddy 客户端直连官方 API（不走 wb-shim），官方限流时客户端弹 errorBanner
 *   （中文「您的使用量将在 {time} 重置…」/英文 "usage will reset at {time}"），
 *   服务端原本完全看不见这个信号。本监听器挂在客户端 CDP 调试端口上，用
 *   MutationObserver 被动捕获播报文本，解析模型 + 重置时间后 POST 给
 *   wb-shim 的内部接口种入限流状态（首页徽章即时准，rate-guard 免探针期）。
 *
 * 设计要点：
 *   - 纯被动：只读 DOM，不点不填不改客户端任何状态（不引风控注意）
 *   - 自愈：CDP 断线 / 客户端重启 / 页面 reload 全部自动重连重注入
 *   - 去重：同一播报文本 10 分钟窗口内只上报一次
 *   - 解析放 node 侧（时区/格式可控），页面只回传原始文本
 *
 * 运行：
 *   node client-rate-watch.mjs            # 常驻监听（nssm 服务 client-rate-watch）
 *   node client-rate-watch.mjs --probe    # 一次性 DOM 结构探查（排查用，不入 nssm）
 *
 * 环境变量：
 *   CDP_URL          默认 http://127.0.0.1:9223
 *   WB_SHIM_URL      默认 http://127.0.0.1:18796
 *   WB_TOKEN_FILE    默认 ./token.txt（与 daemon 同源）
 *   WATCH_POLL_MS    播报扫描去重窗口外的兜底轮询间隔，默认 15000
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const WB_SHIM_URL = (process.env.WB_SHIM_URL || 'http://127.0.0.1:18796').replace(/\/+$/, '');
const TOKEN_FILE = process.env.WB_TOKEN_FILE || join(HERE, 'token.txt');
const PROBE_MODE = process.argv.includes('--probe');

const log = (...a) => console.log(new Date().toISOString(), '[client-rate-watch]', ...a);

function getToken() {
  try { return readFileSync(TOKEN_FILE, 'utf8').trim().split(/\r?\n/)[0].trim(); } catch { return ''; }
}

// ── 播报文本解析（node 侧）────────────────────────────────────────

/** 从播报文本抠模型显示名（中英文模板都认） */
function extractModel(text) {
  let m = text.match(/您在\s*(.{1,30}?)\s*模型/);
  if (m) return m[1].trim();
  m = text.match(/(?:free usage of|usage of)\s+([A-Za-z0-9 ._\-]{1,40}?)\s+has exceeded/i);
  if (m) return m[1].trim();
  return null;
}

/** 模型显示名 → wb-shim 受管组名（受管组=上游真名；对不上就原样回传，诚实不猜） */
const MODEL_ALIAS = [
  [/step[\s._-]*5/i, 'step-5-preview'],
  [/deepseek[\s._-]*v?4\.1?[\s._-]*flash/i, 'deepseek-v4.1-flash-intl'],
  [/hunyuan[\s._-]*4|^hy[\s._-]*4|混元\s*4/i, 'hy4-preview'],
  [/hy[\s._-]*3[\s._-]*intl|hunyuan[\s._-]*3[\s._-]*intl|混元[\s._-]*3[\s._-]*国际/i, 'hy3-intl'],
  [/hunyuan[\s._-]*3|^hy[\s._-]*3|混元\s*3/i, 'hy3'],
];
function normalizeModel(display) {
  if (!display) return null;
  for (const [re, group] of MODEL_ALIAS) if (re.test(display)) return group;
  return display;
}

/** 从播报文本抠重置时间（多格式，返回 epoch ms 或 null=诚实的未知） */
function parseResetAt(text) {
  const T = String(text);
  // 相对时间：N分钟后 / N小时后 / in N minutes / in N hours
  let m = T.match(/(\d+)\s*分钟后/) || T.match(/in\s+(\d+)\s+minutes/i);
  if (m) return Date.now() + Number(m[1]) * 60_000;
  m = T.match(/(\d+)\s*小时后/) || T.match(/in\s+(\d+)\s+hours/i);
  if (m) return Date.now() + Number(m[1]) * 3_600_000;
  // 绝对时间：2026-10-18 08:00[:00] / 2026/10/18 8:00 / 10月18日 08:00 / ISO
  const pad = (n) => String(n).padStart(2, '0');
  m = T.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/) ||
      T.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/) ||
      T.match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (m) {
    let d;
    try {
      if (m[0].match(/月/)) {
        d = new Date(`${new Date().getFullYear()}-${pad(m[1])}-${pad(m[2])}T${pad(m[3])}:${m[4]}:${m[5] || '00'}+08:00`);
      } else if (m[0].match(/[A-Za-z]{3}\s+\d/)) {
        // Oct 18, 2026, 8:00 AM —— 交给 Date 解析（浏览器 locale 给的英文格式）
        d = new Date(m[0].replace(/,\s*(\d{4})/, ' $1'));
      } else {
        d = new Date(`${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] || '00'}+08:00`);
      }
    } catch { return null; }
    // 播报时间戳一律按东八区解释（官方重置时间是北京时间口径）；
    // 过期=历史转发（丢），超过 72h=解析出了问题（丢，诚实不猜）
    const t = d.getTime();
    if (!Number.isFinite(t) || t <= Date.now() - 60_000 || t > Date.now() + 72 * 3600_000) return null;
    return t;
  }
  return null;
}

/** 判定一段文本是不是限流播报（中/英/官方原文三种口径） */
function isRateLimitNotice(text) {
  const t = String(text);
  if (/soft_rate/i.test(t)) return true;
  if (/频率限制/.test(t) && /重置/.test(t)) return true;
  if (/rate limit/i.test(t) && /reset/i.test(t)) return true;
  return false;
}

export { extractModel, normalizeModel, parseResetAt, isRateLimitNotice };

// ── 页面注入脚本（被动 MutationObserver）──────────────────────────
// 只读 DOM；命中后经 Runtime binding 把原始文本回传 node 侧解析。
// 🔴 防误报双保险（2026-10-17 实测 DOM 后定）：
//   ① 页面侧：只采信 toast/banner 容器里的文本；conversation-history 树
//      （历史消息/侧栏，含用户转发过的旧播报）一律排除——实测旧播报全在这棵树里；
//   ② node 侧：重置时间必须解析成未来时刻，过期时间=历史转发，直接丢。
const PAGE_SCRIPT = String.raw`
(() => {
  if (window.__wbRateWatchInstalled) return 'already';
  window.__wbRateWatchInstalled = true;
  const hit = (text, where) => {
    try { window.__wbRateHit(JSON.stringify({ text: String(text).slice(0, 800), where, currentModel: currentModel() })); } catch (e) {}
  };
  const seen = new Map(); // 归一文本 -> 最近命中 ts（去重）
  const DEDUP_MS = 10 * 60 * 1000;
  const HISTORY_RE = /conversation-history|conversation-hi|message-list|chat-history/i;
  const LIVE_RE = /toast|banner|alert|cb-chat-toast/i;
  // 沿祖先链判定是否实时播报：命中 toast/banner 容器=采信；进历史树=必不采信
  const classify = (node) => {
    let n = node, live = false;
    for (let i = 0; i < 10 && n; i++) {
      const sig = (n.className && String(n.className)) + ' ' + (n.getAttribute && ((n.getAttribute('role') || '') + ' ' + (n.getAttribute('data-testid') || '')));
      if (LIVE_RE.test(sig)) live = true;
      if (HISTORY_RE.test(sig)) return false;
      n = n.parentElement;
    }
    return live;
  };
  const currentModel = () => {
    const el = document.querySelector('.cr-model-selector__trigger-label, [class*=model-selector] [class*=trigger-label], [class*=modelName]');
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  };
  const scanNode = (node) => {
    if (!node || node.nodeType !== 1) return;
    const txt = node.textContent || '';
    if (txt.length < 8 || txt.length > 2000) return;
    if (!/频率限制|soft_rate|rate limit/i.test(txt)) return;
    if (!/重置|reset/i.test(txt)) return;
    if (!classify(node)) return;
    const key = txt.replace(/\s+/g, ' ').trim().slice(0, 120);
    const now = Date.now();
    if (seen.has(key) && now - seen.get(key) < DEDUP_MS) return;
    seen.set(key, now);
    // 往上找播报根节点（banner/alert），拿更完整的文本
    let root = node;
    for (let i = 0; i < 6 && root.parentElement; i++) {
      const p = root.parentElement;
      const sig = (p.className && String(p.className)) + ' ' + (p.getAttribute && p.getAttribute('role') || '');
      if (/banner|alert|toast|notice|error/i.test(sig)) { root = p; break; }
      root = p;
    }
    hit((root.textContent || txt).replace(/\s+/g, ' ').trim(), root.tagName + '.' + String(root.className || '').slice(0, 60));
  };
  const onMut = (muts) => { for (const mu of muts) { for (const n of mu.addedNodes || []) scanNode(n); if (mu.type === 'characterData') scanNode(mu.target); } };
  const obs = new MutationObserver(onMut);
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  // 兜底轮询：observer 可能错过首屏就存在的播报（客户端重启前残留的）
  window.__wbRateWatchScan = () => {
    const nodes = document.querySelectorAll('*');
    for (const n of nodes) { if (n.children.length === 0) scanNode(n); }
  };
  window.__wbRateWatchStop = () => { obs.disconnect(); delete window.__wbRateWatchInstalled; };
  // 暴露手动扫描入口（node 侧每轮兜底调用）
  return 'installed';
})()
`;

// ── CDP 连接 ──────────────────────────────────────────────────────

let msgId = 0;
const pending = new Map();

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); } }, 15_000);
  });
}

async function cdpEval(ws, expression) {
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result?.value;
}

async function findPageTarget() {
  const r = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await r.json();
  const page = list.find((t) => t.type === 'page' && /workbuddy|app\.asar/i.test(t.url + ' ' + t.title));
  if (!page) throw new Error(`没找到 WorkBuddy 页面 target（当前 ${list.length} 个：${list.map((t) => t.type + ':' + t.title.slice(0, 20)).join(', ')}）`);
  return page;
}

// 上报去重窗口（同一 group 同重置时间 10 分钟内不重复种）
const recentReports = new Map(); // key -> ts
function shouldReport(group, resetAt, text) {
  const key = `${group}|${resetAt || 'null'}|${text.replace(/\s+/g, ' ').slice(0, 60)}`;
  const now = Date.now();
  if (recentReports.has(key) && now - recentReports.get(key) < 10 * 60_000) return false;
  recentReports.set(key, now);
  return true;
}

async function reportToShim(payload) {
  const token = getToken();
  const r = await fetch(`${WB_SHIM_URL}/api/rate-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`wb-shim 拒绝: HTTP ${r.status} ${JSON.stringify(j).slice(0, 150)}`);
  return j;
}

async function handleHit(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  const text = obj.text || '';
  if (!isRateLimitNotice(text)) { log(`非限流播报，跳过: ${text.slice(0, 60)}…`); return; }
  const display = extractModel(text) || obj.currentModel || null;
  const group = normalizeModel(display) || '(模型未识别)';
  const resetAt = parseResetAt(text);
  // 🔴 只采信未来的重置时间：历史消息里转发的播报，重置时间必然已过期（parseResetAt
  // 对过期时间返回 null）。宁可漏报，不可错报——错报会让 rate-guard 停探、徽章假亮。
  if (!resetAt) { log(`跳过：解析不到未来的重置时间（疑似历史转发或未知格式）: ${text.slice(0, 50)}…`); return; }
  if (!shouldReport(group, resetAt, text)) { log(`去重期内，跳过: ${group}`); return; }
  log(`捕获限流播报：模型=${display || '?'} → 组=${group} 重置=${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })}`);
  try {
    const j = await reportToShim({ model: group, status: 'rate-limited', resetAt, reason: text.slice(0, 200), source: 'client-cdp' });
    log(`已种入 wb-shim: ${j.group}（${j.state?.status}）`);
  } catch (e) {
    log(`种入失败（下条播报会重试）: ${e.message}`);
  }
}

async function probeMode() {
  const page = await findPageTarget();
  log(`probe: 连上 ${page.title} (${page.url.slice(0, 80)}…)`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连不上')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  };
  await cdpSend(ws, 'Runtime.enable');
  const dump = await cdpEval(ws, `JSON.stringify((() => {
    const out = { bannerLike: [], modelSelectors: [], rateWords: [] };
    for (const el of document.querySelectorAll('[class], [role], [data-testid]')) {
      const sig = (el.className && String(el.className)) + '|' + (el.getAttribute('role') || '') + '|' + (el.getAttribute('data-testid') || '');
      if (/banner|alert|toast|notice/i.test(sig)) out.bannerLike.push({ sig: sig.slice(0, 90), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
      if (/model|模型/i.test(sig)) out.modelSelectors.push({ sig: sig.slice(0, 90), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    }
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '');
      if (el.children.length === 0 && /频率限制|soft_rate|rate limit|重置/i.test(t) && t.length < 400) out.rateWords.push(t.replace(/\s+/g, ' ').trim().slice(0, 120));
    }
    out.bannerLike = out.bannerLike.slice(0, 15); out.modelSelectors = out.modelSelectors.slice(0, 15); out.rateWords = out.rateWords.slice(0, 15);
    return out;
  })())`);
  console.log(dump ? JSON.stringify(JSON.parse(dump), null, 2) : '(空)');
  ws.close();
}

async function watchLoop() {
  while (true) {
    let ws = null;
    try {
      const page = await findPageTarget();
      log(`连上客户端 CDP: ${page.title}`);
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连不上')); ws.onclose = () => rej(new Error('WS 秒断')); });
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); return; }
        // Runtime binding 回调：页面里 __wbRateHit(...) 的调用
        if (m.method === 'Runtime.bindingCalled' && m.params?.name === '__wbRateHit') {
          handleHit(m.params.payload).catch((e) => log('处理播报异常:', e.message));
        }
      };
      await cdpSend(ws, 'Runtime.enable');
      await cdpSend(ws, 'Page.enable');
      await cdpSend(ws, 'Runtime.addBinding', { name: '__wbRateHit' });
      // 页面 reload/客户端重启后在新执行上下文里重新注入（幂等，页面内有 guard）
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Runtime.executionContextCreated') {
          cdpEval(ws, PAGE_SCRIPT).catch(() => {});
        }
      });
      const injected = await cdpEval(ws, PAGE_SCRIPT);
      log(`observer 注入: ${injected}`);
      // 常驻：等 WS 断开（客户端重启/关页面）后外层循环重连
      await new Promise((res) => { ws.onclose = res; ws.onerror = res; });
      log('CDP 连接断开，3s 后重连…');
    } catch (e) {
      log(`连接失败: ${e.message}，5s 后重试…`);
    } finally {
      try { ws && ws.close(); } catch {}
    }
    await new Promise((r) => setTimeout(r, ws ? 3000 : 5000));
  }
}

// 主入口守卫：仅直接运行本文件时才启动监听（被 import 做单测时不触发）
const IS_MAIN = (() => {
  try { return !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('client-rate-watch.mjs'); } catch { return false; }
})();

if (IS_MAIN && PROBE_MODE) {
  probeMode().catch((e) => { log('probe 失败:', e.message); process.exit(1); });
} else if (IS_MAIN) {
  log(`启动：CDP=${CDP_URL} → wb-shim=${WB_SHIM_URL}（纯被动监听，不碰客户端状态）`);
  watchLoop().catch((e) => { log('致命:', e); process.exit(1); });
}
