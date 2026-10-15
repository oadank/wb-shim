/**
 * wb-alert-push.mjs —— wb-shim 限免/积分告警推送（2026-10-13）
 *
 * 干什么：轮询 wb-shim 的 /alerts，出现新告警就用 DSH bot 身份推给老大。
 * 为什么独立进程：daemon.mjs 是请求服务，崩了/重启了推送不能跟着停；
 * 且推送要读飞书凭据、走外网，跟本地反代解耦更稳。
 *
 * 🔴 飞书 open_id 跨应用不通用（实测踩坑）：DSH bot（cli_a93fe9c803b89cc8）视角下
 * 老大陈丹的 open_id 是 ou_888b94e17b7d3d6dcc21ddbc6b35abb4，不是别的 bot 视角那个
 * ou_a1dec4c18c6ce9030d6330e2dce78949（拿错会报 open_id cross app）。
 * 🔴 老大 2026-10-13 钦定：**只私聊，不发群、不 @、不群发**。本脚本无任何群发能力。
 *
 * 配置全走环境变量（nssm AppEnvironmentExtra 注入），无硬编码：
 *   WB_SHIM_ALERTS_URL  默认 http://127.0.0.1:18796/alerts
 *   LARK_APP_ID / LARK_APP_SECRET   必填，DSH bot 凭据
 *   LARK_ALERT_AT_OPEN_ID 默认老大（dsh bot 视角），私聊直达
 *   ALERT_POLL_MS       默认 60000（1 分钟一轮）
 *   ALERT_STATE_FILE    默认同目录 .alert-push-state.json（去重水位）
 *
 * 去重：只推"没推过的告警"。每条告警有唯一 key（variant+kind+内容），
 * 推成功才写水位，重启不重复推。
 *
 * 限频：同类告警 10 分钟内最多推 1 条（防限免反复横跳刷屏）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordNotify } from './notify-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const ALERTS_URL = process.env.WB_SHIM_ALERTS_URL || 'http://127.0.0.1:18796/alerts';
const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
// 老大在 DSH bot（cli_a93fe9c803b89cc8）视角下的 open_id，私聊直达
const AT_OPEN_ID = process.env.LARK_ALERT_AT_OPEN_ID || 'ou_888b94e17b7d3d6dcc21ddbc6b35abb4';
const POLL_MS = Number(process.env.ALERT_POLL_MS || 60 * 1000);
const STATE_FILE = process.env.ALERT_STATE_FILE || join(HERE, '.alert-push-state.json');
const REFRESH_INTERVAL_MS = 90 * 60 * 1000; // tenant_access_token 2h 过期，90 分钟主动换
const SAME_KIND_COOLDOWN_MS = 10 * 60 * 1000; // 同类告警 10 分钟限频

const log = (...a) => console.log(new Date().toISOString(), '[wb-alert-push]', ...a);

// ── 状态水位（推过什么）────────────────────────────────
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { pushed: {}, lastPushAt: {} };
  }
}
function saveState(s) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
  } catch (e) {
    log('状态写盘失败（不影响推送，重启后会重推几条）:', String(e));
  }
}

// ── 飞书 tenant_access_token（带缓存，过期自动换）──────
let tokenCache = { token: '', at: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() - tokenCache.at < REFRESH_INTERVAL_MS) return tokenCache.token;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`tenant_access_token 失败: code=${j.code} msg=${j.msg}`);
  tokenCache = { token: j.tenant_access_token, at: Date.now() };
  log('tenant_access_token 已获取/刷新');
  return tokenCache.token;
}

/** 私聊发文本给老大（DSH bot 身份，不是冒充用户；open_id 用 dsh bot 视角） */
async function sendText(text, kind = 'alert', meta) {
  const token = await getToken();
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: AT_OPEN_ID,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`发消息失败: code=${j.code} msg=${j.msg}`);
  // 记历史（看板展示用）
  recordNotify('alert-push', kind, text, meta);
  return j.data?.message_id;
}

// ── 告警文案 ──────────────────────────────────────────
function fmtAlert(variant, a) {
  const when = new Date(a.t).toLocaleString('zh-CN', { hour12: false });
  if (a.kind === 'free-gone') {
    return [
      `🔴 [wb-shim] 限免到期/被撤（${variant}）`,
      `模型：${a.ids.join('、')}`,
      `时间：${when}`,
      `影响：主力腿可能开始烧积分。 litellm 降级链在跑（wbi→wb→DS官方→agnes），断供不会，但要去把权重调了。`,
    ].join('\n');
  }
  if (a.kind === 'free-added') {
    return [
      `🟢 [wb-shim] 新白嫖上线（${variant}）`,
      `模型：${a.ids.join('、')}`,
      `时间：${when}`,
      `积分当前：见 /alerts。要不要接进 litellm 你定。`,
    ].join('\n');
  }
  if (a.kind === 'credits-low') {
    return [
      `🔴 [wb-shim] 积分低水位（${variant}）`,
      `剩余：${a.total}`,
      `时间：${when}`,
      `影响：积分快见底，付费腿即将断供。免费腿（intl）不受影响。`,
    ].join('\n');
  }
  return `⚠️ [wb-shim] 未知告警（${variant}）: ${JSON.stringify(a)}`;
}

function alertKey(variant, a) {
  return `${variant}|${a.kind}|${(a.ids ?? []).join(',')}|${a.total ?? ''}`;
}

// ── 主循环 ───────────────────────────────────────────
let stopping = false;

async function pollOnce(state) {
  let data;
  try {
    const r = await fetch(ALERTS_URL, { signal: AbortSignal.timeout(15_000) });
    data = await r.json();
  } catch (e) {
    log('拉 /alerts 失败（下轮重试）:', String(e).slice(0, 120));
    return;
  }
  for (const v of data.variants ?? []) {
    for (const a of v.alerts ?? []) {
      const key = alertKey(v.id, a);
      if (state.pushed[key]) continue; // 推过了
      // 同类限频：10 分钟内推过同 kind 就跳过
      const lastAt = state.lastPushAt[`${v.id}|${a.kind}`] ?? 0;
      if (Date.now() - lastAt < SAME_KIND_COOLDOWN_MS) {
        log(`限频跳过（${v.id}/${a.kind} 10 分钟内已推）`);
        state.pushed[key] = Date.now(); // 标记已处理，防水位无限增长
        continue;
      }
      try {
        const mid = await sendText(fmtAlert(v.id, a), a.kind, { variant: v.id, ...a });
        state.pushed[key] = Date.now();
        state.lastPushAt[`${v.id}|${a.kind}`] = Date.now();
        log(`已推送 ${v.id}/${a.kind} → message_id=${mid}`);
      } catch (e) {
        // 推送失败不写水位，下轮重试（飞书抽风不该丢告警）
        log(`推送失败（下轮重试） ${v.id}/${a.kind}:`, String(e).slice(0, 160));
      }
    }
  }
  // 水位防无限增长：只留最近 500 条
  const keys = Object.keys(state.pushed);
  if (keys.length > 500) {
    const sorted = keys.sort((x, y) => state.pushed[y] - state.pushed[x]).slice(0, 500);
    const np = {};
    for (const k of sorted) np[k] = state.pushed[k];
    state.pushed = np;
  }
}

async function main() {
  if (!APP_ID || !APP_SECRET || !AT_OPEN_ID) {
    console.error('[wb-alert-push] 缺配置：LARK_APP_ID / LARK_APP_SECRET / LARK_ALERT_AT_OPEN_ID 必填，退出');
    process.exit(1);
  }
  log(`启动：poll=${ALERTS_URL} every=${POLL_MS}ms 私聊 open_id=${AT_OPEN_ID.slice(0, 14)}…`);
  const state = loadState();
  // 🔴 启动探活默认关闭（2026-10-13 老大被轰炸 48 条后立）：每次重启都发一条飞书，
  // 调试时重启几十次=骚扰几十次。想开发布通知时才开（ALERT_ANNOUNCE_ON_BOOT=1）。
  if (process.env.ALERT_ANNOUNCE_ON_BOOT === '1') {
    try {
      await sendText('wb-shim 告警推送已上线。以后限免到期、新免费模型、积分快用完，都会私聊告诉你。');
      log('启动公告已发（ALERT_ANNOUNCE_ON_BOOT=1）');
    } catch (e) {
      log('启动公告失败:', String(e).slice(0, 160));
    }
  } else {
    log('启动公告已默认关闭（要开发布通知设 ALERT_ANNOUNCE_ON_BOOT=1）');
  }
  while (!stopping) {
    await pollOnce(state);
    saveState(state);
    // 可取消的等待：signal 来了立刻醒，不让 nssm 卡 STOP_PENDING
    // （旧写法 setTimeout(r, POLL_MS) 没人叫醒，SIGTERM 后要干等满 60s）
    await new Promise((resolve) => {
      wake = resolve;
      // 🔴 绝不能 unref()：unref 的语义是"这个 timer 不阻止进程退出"，
      // 没有其他活跃句柄时事件循环一空，node 就直接退了（表现为服务起不来、
      // exit=0、无报错）。2026-10-14 踩过这个坑，排查了半天。
      timer = setTimeout(() => { wake = null; timer = null; resolve(); }, POLL_MS);
    });
  }
  log('轮询循环已退出，进程结束');
}

/** 当前轮询等待的唤醒句柄——signal 处理函数用来打断睡眠 */
let wake = null;
let timer = null;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，立即停');
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (wake) { const w = wake; wake = null; w(); }
  });
}

main().catch((e) => { console.error('[wb-alert-push] 致命错误:', e); process.exit(1); });
