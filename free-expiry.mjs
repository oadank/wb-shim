#!/usr/bin/env node
/**
 * free-expiry.mjs —— 免费模型到期管理（2026-10-13）
 *
 * 干什么（老大要的"落地感"）：
 *   1. 提前预告：到期前 N 天/小时/分钟，私聊老大，人话说清"谁要到期、几号、影响谁、我会干啥"
 *   2. 到点自动切换：autoRetire=true 的模型到期那一刻，自动把它在 litellm 里所有腿的
 *      weight 改成 0、离线校验、重启 litellm——免费腿自动让位给下一腿，不用人管
 *   3. 新模型侦察：发现上游新上架的免费模型，登记提示（不自动加进 litellm，只报）
 *
 * 数据：free-expiry.json（到期登记表，人工维护+推断标注）
 * 推送：复用 alert-push.mjs 的飞书通道（DSH bot 私聊老大）
 * 运行：nssm 服务 free-expiry（与 alert-push 分开，互不拖累）
 *
 * 🔴 铁律：改 litellm 前必 .bak 备份 + 离线 parse 校验 + 重启后回读 RUNNING + 实测一发。
 *   任何一步失败立刻放弃本次自动切换，改发飞书喊人，绝不硬上。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { recordNotify } from './notify-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'free-expiry.json');
const LITELLM_YAML = 'C:\\D\\opt\\litellm\\venv\\litellm_config.yaml';
const LITELLM_PY = 'C:\\D\\opt\\litellm\\venv\\Scripts\\python.exe';
const STATE_FILE = process.env.FREE_EXPIRY_STATE || join(HERE, '.free-expiry-state.json');
const POLL_MS = Number(process.env.FREE_EXPIRY_POLL_MS || 5 * 60 * 1000); // 5 分钟一轮
const ALERTS_URL = process.env.WB_SHIM_ALERTS_URL || 'http://127.0.0.1:18796/alerts';
const WB_SHIM_BASE = process.env.WB_SHIM_BASE || 'http://127.0.0.1:18796';
const MODELS_URL = 'http://127.0.0.1:18796/v1/models';
const MODELS_TOKEN_FILE = join(HERE, 'token.txt');

const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
const AT_OPEN_ID = process.env.LARK_ALERT_AT_OPEN_ID || 'ou_888b94e17b7d3d6dcc21ddbc6b35abb4';

const log = (...a) => console.log(new Date().toISOString(), '[free-expiry]', ...a);
/** 本地（北京）日期 YYYY-MM-DD。🔴 不能用 toISOString()——那是 UTC 日期，
 *  北京时间凌晨 0-8 点会拿到"昨天"，每日摘要在这 8 小时里会判错"今天"（2026-10-14 老大警告过时间转换） */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 飞书私聊（与 alert-push 同通道，代码内联避免跨文件依赖）─────────
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
async function sendText(text, kind = 'info', meta) {
  const token = await getToken();
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: AT_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`发消息失败: ${j.code} ${j.msg}`);
  // 记历史（看板展示用）
  recordNotify('free-expiry', kind, text, meta);
  return j.data?.message_id;
}

// ── 状态水位（提醒过没、退休办没办）──────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { notified: {}, retired: {} }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { log('状态写盘失败:', String(e)); }
}

// ── 人话文案 ────────────────────────────────────────
function humanLeft(ms) {
  if (ms <= 0) return '已到期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  return `${m} 分钟`;
}
function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function notifyText(e, msLeft, stage) {
  const model = `${e.model}（${e.variant}）`;
  const when = fmtDate(e.expiry);
  const impact = e.autoRetire
    ? '它是现在的主力免费腿，到期那天我会自动把它挪出主力组，换成备用腿接着干活，不用你操心。'
    : '它不是主力，到期了我只会告诉你一声，不影响日常使用。';
  const inferredNote = e.inferred ? '\n（注意：这个到期日是我从公告推出来的，不是官方接口给的，可能差一两天）' : '';
  if (stage === 'final') {
    return `⏰ 最后提醒：${model} 的免费还剩 ${humanLeft(msLeft)}，${when} 正式到期。${impact}${inferredNote}`;
  }
  if (stage === 'retired') {
    return `🔧 已自动切换：${model} 刚到到期日（${when}），我已把它从免费模型组挪走，备用腿已顶上。日常使用无感，跟你报一声。`;
  }
  return `📢 免费提醒：${model} 还能免费用 ${humanLeft(msLeft)}，${when} 到期。${impact}${inferredNote}`;
}

// ── litellm 自动切换：把某上游模型的腿 weight 全改 0 ────
/**
 * 🔴 按 yaml 里的 model 字段值（上游模型名）匹配，不是 litellm 组名。
 * 登记表的 upstreamModel 填上游名（如 deepseek-v4.1-flash-intl）；
 * 填组名（wbi-dsv4.1f）会一条都匹配不上——那是 model_name 不是 model。
 * 国内/国际同名模型是不同字符串（-intl 后缀），整词相等不会互撞。
 * 返回 { ok, reason, changed, bak }。只改 weight 不删腿，保可回滚。
 * 安全闸：备份 → 替换 → 离线 parse 校验；失败自动还原并说清原因。
 */
function retireModelInLitellm(upstreamModel) {
  const src = readFileSync(LITELLM_YAML, 'utf8');
  // 定位该上游模型名出现的 deployment 块，把块内 weight: N 改 0
  const lines = src.split('\n');
  const changed = [];
  let curName = null;
  for (let i = 0; i < lines.length; i++) {
    const mName = lines[i].match(/^\s*-\s*model_name:\s*(\S+)\s*$/);
    if (mName) { curName = mName[1]; continue; }
    const mModel = lines[i].match(/^\s*model:\s*(?:(?:openai|anthropic)\/)?([^\s]+)\s*$/);
    if (mModel && mModel[1] === upstreamModel) {
      // 本块内往下找 weight 行；找到就改 0，找不到（如 wb-hy3 无 weight 默认100）
      // 就在块尾（下一个 deployment 前）插入 weight: 0——否则漏改，模型照样被选中
      let j = i + 1;
      let handled = false;
      for (; j < Math.min(i + 30, lines.length); j++) {
        const mW = lines[j].match(/^(\s*)weight:\s*(\d+)\s*$/);
        if (mW) {
          if (mW[2] !== '0') { lines[j] = `${mW[1]}weight: 0`; changed.push(`${curName}@L${j + 1}`); }
          handled = true;
          break;
        }
        if (/^\s*-\s*model_name:/.test(lines[j])) break;
      }
      if (!handled) {
        // 插在本块最后一行之后（j 指向下一个 model_name 行或块尾）
        const indent = '    ';
        lines.splice(j, 0, `${indent}weight: 0`);
        changed.push(`${curName}@L${j + 1}(插入)`);
      }
    }
  }
  if (!changed.length) return { ok: false, reason: `litellm 里找不到 ${upstreamModel} 的 weight 腿（已退休/名字不对/该组本就没 weight 字段）`, changed: [] };
  const out = lines.join('\n');
  // 备份 + 离线校验
  const bak = `${LITELLM_YAML}.bak-auto-retire-${localDate()}`;
  try {
    copyFileSync(LITELLM_YAML, bak);
    writeFileSync(LITELLM_YAML, out, 'utf8');
    execFileSync(LITELLM_PY, ['-c', `import yaml;yaml.safe_load(open(r'${LITELLM_YAML}',encoding='utf-8'))`], { stdio: 'pipe' });
    return { ok: true, changed, bak };
  } catch (e) {
    // 写坏/校验炸 → 从备份还原
    try { copyFileSync(bak, LITELLM_YAML); } catch {}
    return { ok: false, reason: `自动切换失败已还原：${String(e).slice(0, 200)}`, changed: [] };
  }
}
function restartLitellm() {
  execFileSync('nssm', ['restart', 'litellm'], { stdio: 'pipe' });
  // 回读：必须 RUNNING 才算数
  const out = execFileSync('sc', ['query', 'litellm'], { encoding: 'utf8' });
  if (!/STATE\s*:\s*4\s+RUNNING/.test(out)) throw new Error(`litellm 重启后不是 RUNNING：${out.slice(0, 120)}`);
}

// ── 主循环 ─────────────────────────────────────────
let stopping = false;
let wake = null, timer = null;

async function pollOnce(state) {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const now = Date.now();
  // 拉 /alerts：拿两个 variant 的 credits + freeModels（烧速监控和每日摘要都用它）
  let alertData = null;
  try {
    const r = await fetch(ALERTS_URL, { signal: AbortSignal.timeout(15_000) });
    alertData = await r.json();
  } catch (e) { log('拉 /alerts 失败（烧速/摘要跳本轮）:', String(e).slice(0, 100)); }
  // P0-1 烧速监控
  if (alertData?.variants) { try { await checkBurnSpike(state, alertData.variants); } catch (e) { log('烧速检查异常:', String(e).slice(0, 150)); } }
  // P0-2 每日摘要
  if (alertData?.variants) { try { await maybeDailySummary(state, alertData.variants); } catch (e) { log('摘要异常:', String(e).slice(0, 150)); } }
  // P1-2 时段路由（hy4-preview 夜间免费窗口）
  try { await applyTimeWindowRouting(state); } catch (e) { log('时段路由异常:', String(e).slice(0, 150)); }
  // P1-1 新免费模型自动发现+登记（只建显式组，提权要人拍板）
  if (alertData?.variants) { try { await autoRegisterNewFree(state, alertData.variants); } catch (e) { log('新模型侦察异常:', String(e).slice(0, 150)); } }
  // P2 兜底链健康自检（每周一次）
  try { await healthCheckFallbackChain(state); } catch (e) { log('自检异常:', String(e).slice(0, 150)); }
  for (const e of cfg.entries ?? []) {
    // 无 expiry 的条目（付费模型参考档案，不参与到期管理）
    if (!e.expiry) continue;
    const expMs = new Date(e.expiry).getTime();
    if (!Number.isFinite(expMs)) { log(`登记表条目 expiry 无法解析，跳过：${e.model}`); continue; }
    const left = expMs - now;
    const key = e.model + '|' + e.variant;
    // 1) 到点自动退休
    if (left <= 0 && e.autoRetire && !state.retired[key]) {
      log(`${key} 已到期，执行自动切换`);
      const r = retireModelInLitellm(e.upstreamModel);
      if (r.ok) {
        try {
          restartLitellm();
          state.retired[key] = { at: now, changed: r.changed, bak: r.bak };
          await sendText(fmtRetired(e), 'retired', { model: e.model, changed: r.changed });
          log(`已切换并通知：${r.changed.join(', ')}`);
        } catch (err) {
          // 重启失败：yaml 已改但服务没起来 → 最高优先级喊人 + 从备份还原
          try { copyFileSync(r.bak, LITELLM_YAML); } catch {}
          await sendText(`🚨 紧急：${e.model} 到期自动切换时 litellm 重启失败，我已把配置还原回原样，服务继续用旧腿跑（免费模型若已失效可能开始烧积分）。请人工检查：${String(err).slice(0, 200)}`, 'restart-failed', { model: e.model });
          log('重启失败已还原并告警');
        }
      } else {
        await sendText(`🚨 自动切换没做成：${e.model} 到期了，但改 litellm 失败（${r.reason}）。我已不改任何东西，请你人工处理。`, 'retire-failed', { model: e.model, reason: r.reason });
        state.retired[key] = { at: now, failed: r.reason }; // 标记防重复喊
      }
      continue;
    }
    // 2) 分级提前提醒：只发"最接近的那一档"（剩 3 天时不会把 30 天档也发一遍）
    if (left > 0) {
      const stages = [...(e.notifyBeforeMinutes ?? [])].sort((a, b) => a - b); // 升序：1,120,1440...
      // 找第一个 >= left 的档位；left 比最小档还小就归到最小档
      const hit = stages.find((m) => left <= m * 60000) ?? stages[stages.length - 1];
      if (hit !== undefined) {
        const nk = `${key}|${hit}`;
        if (!state.notified[nk]) {
          const stage = hit <= 1 ? 'final' : 'normal';
          try {
            await sendText(notifyText(e, left, stage), 'expiry-notice', { model: e.model, leftMs: left, stage });
            state.notified[nk] = now;
            log(`已推送预告 ${nk}（剩 ${humanLeft(left)}）`);
          } catch (err) {
            log(`预告推送失败 ${nk}（下轮重试）:`, String(err).slice(0, 120));
          }
        }
      }
    }
  }
}

/** 到期自动切换完成后的通知文案 */
function fmtRetired(e) {
  const when = fmtDate(e.expiry);
  return `🔧 已自动切换：${e.model}（${e.variant}）刚到到期日（${when}），我已把它从免费模型组挪走，备用腿已顶上。日常使用无感，跟你报一声。`;
}

// ── P1-1 新免费模型自动发现 + 安全试跑进 litellm ─────────────────────
/**
 * 上游新上架的免费模型（wb-shim 每 6h 重抓目录就能看到）自动进 litellm：
 *   1. 与"已登记的"（litellm 里已有 + 登记表里见过）比对，找出新的免费模型
 *   2. 第一轮只**通知**（人话：新模型、倍率、上下文、能力），不动 litellm
 *   3. 同时在 litellm 建一个**显式组**（model_name: wbauto-<id>，weight 默认），
 *      只挂显式位不进主力组——想用得手动点名，不会偷偷改变现有路由
 *   4. 24h 后若它仍在免费名单里，私聊问你要不要提进主力组（不自动提权，
 *      提权=可能改变全家路由，这一步必须人拍板）
 * 水位 state.autoNew：{ "<variant>|<id>": { firstSeen, notified, promoted } }
 */
const AUTO_PREFIX = process.env.AUTO_MODEL_PREFIX || 'wbauto-';

function existingModelIds() {
  const src = readFileSync(LITELLM_YAML, 'utf8');
  const ids = new Set();
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*model:\s*(?:(?:openai|anthropic)\/)?([^\s]+)\s*$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function litellmHasDeploymentFor(upstreamId) {
  return existingModelIds().has(upstreamId);
}

/** 在 litellm 的 model_list 段末尾追加一个显式 deployment（不改动任何现有组）
 * 🔴 绝不能往文件末尾 append——yaml 结尾是 general_settings/pass_through_endpoints，
 * 塞那儿结构就烂了。必须插在 `router_settings:` 行之前（= model_list 的结束位置）。
 */
function appendDeployment(upstreamId, isIntl) {
  const src = readFileSync(LITELLM_YAML, 'utf8');
  const groupName = `${AUTO_PREFIX}${upstreamId}`.replace(/[^a-zA-Z0-9._-]/g, '-');
  const token = readFileSync(join(HERE, 'token.txt'), 'utf8').trim();
  const block = [
    '',
    `# [auto ${localDate()}] 新免费模型自动登记（P1-1）：${upstreamId}${isIntl ? '（国际版）' : ''}`,
    `# 只挂显式组，不进主力组——要用请手动点名 ${groupName}；24h 后私聊问是否提权`,
    `- model_name: ${groupName}`,
    '  litellm_params:',
    '    drop_params: true',
    `    model: openai/${upstreamId}`,
    '    api_base: http://127.0.0.1:18796/v1',
    `    api_key: ${token}`,
    '    supports_function_calling: true',
    '    timeout: 300',
    '    max_parallel_requests: 2',
    '    weight: 10',
    '',
  ].join('\n');
  // 找 router_settings: 行（顶格），插在它前面；找不到则退化为文件末尾（并告警）
  const lines = src.split('\n');
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^router_settings:\s*$/.test(lines[i])) { insertAt = i; break; }
  }
  if (insertAt < 0) {
    return { ok: false, reason: '找不到 router_settings: 锚点，拒绝追加（防把 deployment 塞进 general_settings）' };
  }
  lines.splice(insertAt, 0, block);
  const out = lines.join('\n');
  const bak = `${LITELLM_YAML}.bak-autonew-${localDate()}`;
  try {
    copyFileSync(LITELLM_YAML, bak);
    writeFileSync(LITELLM_YAML, out, 'utf8');
    execFileSync(LITELLM_PY, ['-c', `import yaml;yaml.safe_load(open(r'${LITELLM_YAML}',encoding='utf-8'))`], { stdio: 'pipe' });
    return { ok: true, groupName, bak };
  } catch (e) {
    try { copyFileSync(bak, LITELLM_YAML); } catch {}
    return { ok: false, reason: String(e).slice(0, 200) };
  }
}

async function autoRegisterNewFree(state, variants) {
  state.autoNew = state.autoNew || {};
  const known = existingModelIds();
  const now = Date.now();
  for (const v of variants) {
    for (const id of v.freeModels ?? []) {
      // wb-shim 的 freeModels 是国内真名/国际真名；国际版在上游要加 -intl
      const isIntl = v.id !== 'workbuddy';
      const upstreamId = isIntl ? `${id}-intl` : id;
      const key = `${v.id}|${id}`;
      if (known.has(upstreamId)) { // litellm 里已有（不管是主力还是显式）→ 不重复
        if (!state.autoNew[key]) state.autoNew[key] = { firstSeen: now, notified: true, reason: 'already-in-litellm' };
        continue;
      }
      // 新免费模型：首轮通知 + 建显式组
      if (!state.autoNew[key]) {
        state.autoNew[key] = { firstSeen: now, notified: false, promoted: false };
      }
      const rec = state.autoNew[key];
      if (!rec.notified) {
        const m = await fetchModelMeta(upstreamId);
        try {
          await sendText([
            `🆕 发现新免费模型：${upstreamId}${isIntl ? '（国际版）' : ''}`,
            `倍率 ${m?.credits_rate ?? '0.00x（免费）'}，上下文 ${m?.context_window ? fmtCtx(m.context_window) : '未知'}${m?.supports_images ? '，支持图片' : ''}${m?.reasoning ? '，思考型' : ''}。`,
            `我已它在 litellm 里建了个显式组（想用得手动点名），没有动你现有的路由。`,
            `24 小时后如果它还在免费名单里，我会再来问你要不要提进主力组。`,
          ].join('\n'), 'new-model', { model: upstreamId, variant: isIntl ? 'intl' : 'cn' });
          rec.notified = true;
          log(`新免费模型已通知：${upstreamId}`);
        } catch (e) { log(`新模型通知失败 ${upstreamId}:`, String(e).slice(0, 100)); }
      }
      if (rec.notified && !rec.deployed) {
        const r = appendDeployment(upstreamId, isIntl);
        if (r.ok) {
          try { restartLitellm(); rec.deployed = true; log(`新免费模型已建显式组并重启 litellm：${r.groupName}`); }
          catch (err) {
            try { copyFileSync(r.bak, LITELLM_YAML); } catch {}
            try { await sendText(`🚨 新模型 ${upstreamId} 登记进 litellm 时重启失败，已还原，下次重试。`, 'new-model-failed', { model: upstreamId }); } catch {}
          }
        } else {
          log(`新模型建组失败 ${upstreamId}: ${r.reason}`);
        }
      }
      // 24h 后问是否提权（只问一次）
      if (rec.deployed && !rec.promoted && now - rec.firstSeen > 24 * 3600000) {
        rec.promoted = true; // 标记问过了，防重复
        try {
          await sendText([
            `❓ ${upstreamId} 免费已满 24 小时且仍在免费名单里。`,
            `要不要把它提进主力组（比如当 claude-model/codex-model 的备用腿）？`,
            `回"提权"我就改；不回就维持显式组，到期自动清理。`,
          ].join('\n'), 'promote-ask', { model: upstreamId });
          log(`已问提权：${upstreamId}`);
        } catch {}
      }
    }
  }
}

async function fetchModelMeta(upstreamId) {
  try {
    const token = readFileSync(join(HERE, 'token.txt'), 'utf8').trim();
    const r = await fetch('http://127.0.0.1:18796/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    return (j.data ?? []).find((m) => m.id === upstreamId || m.id === upstreamId.replace(/-intl$/, ''));
  } catch { return null; }
}
function fmtCtx(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// ── P2 兜底链健康自检 ─────────────────────────────────
/**
 * 每周一次，把 litellm 主力组（claude-model/codex-model/QW3.8F）各打一发真实
 * 请求，全绿才沉默；有红立即私聊（备胎挂了几个月不知道是最蠢的死法）。
 * 水位 state.healthCheck：{ lastAt, lastResult }
 */
const HEALTH_CHECK_GROUPS = ['claude-model', 'codex-model', 'QW3.8F'];
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 7 * 86400000);

async function healthCheckFallbackChain(state) {
  const now = Date.now();
  if (state.healthCheck && now - state.healthCheck.lastAt < HEALTH_INTERVAL_MS) return;
  state.healthCheck = { lastAt: now, lastResult: null };
  log('开始兜底链健康自检');
  const results = [];
  for (const g of HEALTH_CHECK_GROUPS) {
    try {
      const r = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-CHANGEME' },
        body: JSON.stringify({ model: g, messages: [{ role: 'user', content: 'ping，回一个字' }], max_tokens: 50 }),
        signal: AbortSignal.timeout(60_000),
      });
      const j = await r.json();
      const ok = r.status === 200 && j.choices?.[0]?.message;
      results.push({ group: g, ok, detail: ok ? (j.choices[0].message.content || '(空)').slice(0, 20) : JSON.stringify(j).slice(0, 80) });
    } catch (e) { results.push({ group: g, ok: false, detail: String(e).slice(0, 80) }); }
  }
  const bad = results.filter((r) => !r.ok);
  state.healthCheck.lastResult = results;
  if (bad.length) {
    try {
      await sendText([
        `🚨 兜底链自检发现 ${bad.length} 个组不通：`,
        ...bad.map((b) => `· ${b.group}：${b.detail}`),
        `其他组正常。这条链是免费腿全灭时的退路，建议尽快查。`,
      ].join('\n'), 'health-fail', { groups: bad.map((b) => b.group) });
      log(`自检发现异常：${bad.map((b) => b.group).join(', ')}`);
    } catch {}
  } else {
    log('自检全绿');
  }
}

// ── P1-2 时段路由（hy4-preview 夜间免费窗口 23:00-08:00）────────────────
/**
 * hy4-preview 只有 23:00-次日 08:00 零积分，其余时段 x0.29 正常计费。
 * 做法：到夜间窗口就把它的 litellm 腿 weight 设为有效值（进池可被路由），
 * 早上 8 点自动归零（撤出）。这样夜间重活自动走它，白天不碰，不用人记。
 * 🔴 只在状态翻转时动 litellm（进→出/出→进），不每轮重启。
 * 配置：TIME_WINDOW_MODELS = [{ upstream, start, end, weight }]，默认 hy4 23-08。
 *   跨零点窗口（23→8）按 start>end 处理。
 */
const TIME_WINDOW_MODELS = (() => {
  const raw = process.env.TIME_WINDOW_MODELS;
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } catch {} }
  // 🔴 默认值不能走 JSON.parse('[]')——空数组 parse 成功不抛错，会把默认配置吞成空
  return [{ upstream: 'hy4-preview', start: 23, end: 8, weight: 40 }];
})();

function inWindow(start, end, nowHour) {
  if (start < end) return nowHour >= start && nowHour < end;
  return nowHour >= start || nowHour < end; // 跨零点
}

/** 把某上游模型所有腿 weight 设为指定值（没有 weight 的插入） */
function setModelWeight(upstreamModel, weight) {
  const src = readFileSync(LITELLM_YAML, 'utf8');
  const lines = src.split('\n');
  const changed = [];
  let curName = null;
  for (let i = 0; i < lines.length; i++) {
    const mName = lines[i].match(/^\s*-\s*model_name:\s*(\S+)\s*$/);
    if (mName) { curName = mName[1]; continue; }
    const mModel = lines[i].match(/^\s*model:\s*(?:(?:openai|anthropic)\/)?([^\s]+)\s*$/);
    if (mModel && mModel[1] === upstreamModel) {
      let j = i + 1, handled = false;
      for (; j < Math.min(i + 30, lines.length); j++) {
        const mW = lines[j].match(/^(\s*)weight:\s*(\d+)\s*$/);
        if (mW) {
          if (mW[2] !== String(weight)) { lines[j] = `${mW[1]}weight: ${weight}`; changed.push(`${curName}@L${j + 1}`); }
          handled = true; break;
        }
        if (/^\s*-\s*model_name:/.test(lines[j])) break;
      }
      if (!handled) { lines.splice(j, 0, `    weight: ${weight}`); changed.push(`${curName}@L${j + 1}(插入)`); }
    }
  }
  if (!changed.length) return { ok: false, reason: 'no-match', changed };
  const bak = `${LITELLM_YAML}.bak-timewin-${localDate()}`;
  try {
    copyFileSync(LITELLM_YAML, bak);
    writeFileSync(LITELLM_YAML, lines.join('\n'), 'utf8');
    execFileSync(LITELLM_PY, ['-c', `import yaml;yaml.safe_load(open(r'${LITELLM_YAML}',encoding='utf-8'))`], { stdio: 'pipe' });
    return { ok: true, changed, bak };
  } catch (e) {
    try { copyFileSync(bak, LITELLM_YAML); } catch {}
    return { ok: false, reason: String(e).slice(0, 200), changed: [] };
  }
}

async function applyTimeWindowRouting(state) {
  const hour = new Date().getHours();
  for (const m of TIME_WINDOW_MODELS) {
    const want = inWindow(m.start, m.end, hour);
    const key = `timewin|${m.upstream}`;
    const cur = state.timewin?.[key];
    if (cur === want) continue; // 状态没翻，不动 litellm
    log(`时段路由翻转：${m.upstream} → ${want ? '进池(夜间免费窗口)' : '撤出'}`);
    const r = setModelWeight(m.upstream, want ? m.weight : 0);
    if (r.ok) {
      try { restartLitellm(); state.timewin = state.timewin || {}; state.timewin[key] = want;
        log(`时段路由完成：${r.changed.join(', ')}`);
        if (want) { try { await sendText(`🌙 夜间免费窗口已开启：${m.upstream} 已进池（${m.start}:00-${m.end}:00 零积分），夜间长上下文/图片任务会自动走它。早 ${m.end} 点自动撤出。`, 'timewindow-on', { model: m.upstream, start: m.start, end: m.end }); } catch {} }
      } catch (err) {
        try { copyFileSync(r.bak, LITELLM_YAML); } catch {}
        try { await sendText(`🚨 时段路由失败：${m.upstream} ${want ? '进池' : '撤出'}时 litellm 重启失败，已还原配置。夜间免费窗口本次没开成，不影响白天使用。请人工检查。`, 'timewindow-failed', { model: m.upstream }); } catch {}
      }
    } else {
      state.timewin = state.timewin || {}; state.timewin[key] = want; // 找不到腿也记状态，防每轮重试
      log(`时段路由跳过（${r.reason}）`);
    }
  }
}

// ── P0-1 积分烧速监控 ────────────────────────────────
/**
 * 思路：每轮记积分快照（时间+余量），算出最近 1 小时消耗速率，与"昨天同时段"
 * 和"历史同时段中位数"比。突增 → 私聊喊，带证据（烧了多少、比平时多几倍、
 * 最可疑的原因：限免到期没切干净/某 bot 走了付费腿）。
 * 水位 state.burn：{ "workbuddy": [{t, total}...], "workbuddy-ai": [...] }
 * 防刷屏：同类告警 6 小时限频；速率回落正常后自动解除（不留旧告警）。
 */
const BURN_SPIKE_FACTOR = Number(process.env.BURN_SPIKE_FACTOR || 3); // 超过基线几倍算异常
const BURN_MIN_DELTA = Number(process.env.BURN_MIN_DELTA || 30); // 至少烧这么多分才值得分析（防噪声）
const BURN_ALERT_COOLDOWN_MS = Number(process.env.BURN_ALERT_COOLDOWN_MS || 10 * 60 * 1000); // 🔴 同一异常 10 分钟最多提醒一次（老大令）
const BURN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const BURN_WINDOW_MS = 60 * 60 * 1000; // 统计窗口 1 小时
// 🔴 绝对阈值（2026-10-14 老大实测）：1 小时烧超这么多分必报，不管基线怎么变。
// 之前只有相对基线告警，基线被高消耗拉高后会漏报（"烧速恢复正常"其实是基线被污染）。
// 老大实测 kimi-k3 x1.62 一小时烧 1205 分没报警，就是因为基线被拉高了。
const BURN_ABS_HOURLY = Number(process.env.BURN_ABS_HOURLY || 100);

function pushSnapshot(state, variant, total) {
  state.burn = state.burn || {};
  state.burn[variant] = state.burn[variant] || [];
  state.burn[variant].push({ t: Date.now(), total });
  // 🔴 2026-10-15 修：原 slice(-200) 只覆盖 16.6h，早 8 点摘要看"昨天 24-48h"时窗口空
  // → 昨天消耗恒为 0（老大抓包骂的假账）。留 50h 点 + 3000 点硬顶（50h/5min=600 点，够冗余）。
  const cutoff = Date.now() - 50 * 3600000;
  state.burn[variant] = state.burn[variant].filter((s) => s.t > cutoff).slice(-3000);
}

/** 官方用量时间线：{t, used} 队列（used 只增不减） */
function pushUsage(state, variant, used) {
  state.usage = state.usage || {};
  state.usage[variant] = state.usage[variant] || [];
  state.usage[variant].push({ t: Date.now(), used });
  const cutoff = Date.now() - 50 * 3600000;
  state.usage[variant] = state.usage[variant].filter((s) => s.t > cutoff).slice(-3000);
}

/** 窗口内官方用量增量（官方 CycleCapacityUsed 是真账，直接差分，无跳变问题） */
function usageRate(snaps, now, windowMs) {
  const from = now - windowMs;
  const win = snaps.filter((s) => s.t >= from);
  if (win.length < 3) return null;
  const first = win[0], last = win[win.length - 1];
  const dtH = (last.t - first.t) / 3600000;
  if (dtH < 0.15) return null;
  return { rate: (last.used - first.used) / dtH, consumed: last.used - first.used };
}

function usageBaseline(snaps, now) {
  const rates = [];
  for (let d = 1; d <= 7; d++) {
    const r = usageRate(snaps, now - d * 86400000, BURN_WINDOW_MS);
    if (r && r.consumed >= BURN_MIN_DELTA) rates.push(r.rate);
  }
  if (rates.length < 2) return null;
  rates.sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)];
}

/** 告警发送（水位口径与官方口径共用），official=true 时文案标注官方账 */
async function pushBurnAlert(state, v, nk, cur, base, isSpike, isAbsolute, official = false) {
  if (isSpike || isAbsolute) {
    state.burnAlert = state.burnAlert || {};
    const lastAt = state.burnAlert[nk] ?? 0;
    const now = Date.now();
    if (now - lastAt > BURN_ALERT_COOLDOWN_MS) {
      state.burnAlert[nk] = now;
      const tag = official ? '（官方账）' : '';
      const reason = isAbsolute
        ? `最近 1 小时烧了 ${Math.round(cur.consumed)} 分（超过绝对阈值 ${BURN_ABS_HOURLY} 分）${tag}${isSpike ? `，是平时同时段的 ${(cur.rate / base).toFixed(1)} 倍` : ''}`
        : `最近 1 小时烧了 ${Math.round(cur.consumed)} 分（速率 ${Math.round(cur.rate)} 分/小时），是平时同时段的 ${(cur.rate / base).toFixed(1)} 倍${tag}`;
      try {
        // 🔴 2026-10-15 老大钦定（二改）：告警明细与看板"今日消耗"同口径 = 官方 request-usage 按模型聚合。
        // 拉 wb-shim /usage-detail（磁盘缓存，秒回），只取本告警对应账号的模型 top5。
        let modelLines = [];
        if (official) {
          try {
            const detail = await (await fetch(`${WB_SHIM_BASE}/usage-detail`, { signal: AbortSignal.timeout(90000) })).json();
            const mine = (detail?.variants || []).find((x) => x.id === v.id);
            if (mine?.models?.length) {
              modelLines = ['今天谁在烧（官方账按模型）：',
                ...mine.models.filter((m) => m.credit > 0).slice(0, 5)
                  .map((m) => `· ${m.name}：${m.credit} 分（${m.requests} 次）`)];
            }
          } catch (e) { log('拉 usage-detail 失败（告警降级为无明细）:', String(e).slice(0, 100)); }
        }
        await sendText([
          `🚨 积分消耗异常（${v.id}）`,
          reason,
          `当前余量 ${v.credits} 分。`,
          ...modelLines,
          ...(official ? [] : (() => { const top = topBurners(3); return top.length ? ['今天谁在烧（按积分排）：', ...top.map((t) => `· ${t.name}（x${t.rate}）：${fmtK(t.tokens)} token，约 ${t.credits < 1 ? t.credits.toFixed(2) : Math.round(t.credits)} 分`)] : []; })()),
        ].join('\n'), 'burn-spike', { variant: v.id, rate: Math.round(cur.rate), baseline: base ? Math.round(base) : null, absolute: isAbsolute, official });
        log(`${v.id} 烧速异常已推送（${Math.round(cur.consumed)}/h${official ? ' 官方账' : ''}${isAbsolute ? ' 绝对阈值' : ''}）`);
      } catch (e) { log('烧速告警推送失败:', String(e).slice(0, 120)); }
    }
  } else if (state.burnAlert?.[nk] && (!base || cur.rate < base * 1.5) && !isAbsolute) {
    delete state.burnAlert[nk];
    log(`${v.id} 烧速恢复正常`);
  }
}

/**
 * 🔴 2026-10-15 修（老大骂"240 分 vs 明细 0.01 分对不上"）：
 * 官方结算/账号重置会在一个采样间隔（5min）内一次性扣减大额积分，
 * burnRate 的"首尾相减"把它当成 1 小时烧速 → 连报 6 次假警报。
 * 修法：把窗口内相邻点差值 > CREDIT_JUMP_IGNORE（单间隔掉分超过绝对阈值的一半）
 * 的跳变段识别为官方结算，从消耗里剔除（rate 和 consumed 都剔除）。
 */
function burnRate(snaps, now, windowMs, ignoreJumps = false) {
  const from = now - windowMs;
  const win = snaps.filter((s) => s.t >= from);
  if (win.length < 3) return null;
  const first = win[0], last = win[win.length - 1];
  const dtH = (last.t - first.t) / 3600000;
  if (dtH < 0.15) return null; // 窗口太短不算（防单轮抖动）
  let consumed = first.total - last.total;
  if (ignoreJumps) {
    const JUMP = BURN_ABS_HOURLY / 2; // 单间隔掉分 ≥50 分 = 官方结算跳变（5min 真实烧不出这个数）
    for (let i = 1; i < win.length; i++) {
      const d = win[i - 1].total - win[i].total;
      if (d > JUMP) consumed -= d; // 剔除跳变
    }
    if (consumed < 0) consumed = 0;
  }
  return { rate: consumed / dtH, consumed };
}

/** 基线：过去 7 天同时段（±2h）的速率中位数；样本不足用 null */
function burnBaseline(snaps, now, ignoreJumps = false) {
  const rates = [];
  for (let d = 1; d <= 7; d++) {
    const dayAgo = now - d * 86400000;
    const r = burnRate(snaps, dayAgo, BURN_WINDOW_MS, ignoreJumps);
    if (r && r.consumed >= BURN_MIN_DELTA) rates.push(r.rate);
  }
  if (rates.length < 2) return null;
  rates.sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)];
}

async function checkBurnSpike(state, variants) {
  const now = Date.now();
  for (const v of variants) {
    if (typeof v.credits !== 'number') continue;
    // 🔴 2026-10-15 重写：烧速直接用官方周期用量（/alerts usage.used 时间线），
    // 官方每包 CycleCapacityUsed 是真账，不猜不换算。水位相减只在官方数缺失时兜底。
    pushSnapshot(state, v.id, v.credits);
    if (v.usage && typeof v.usage.used === 'number') {
      pushUsage(state, v.id, v.usage.used);
      const uSnaps = state.usage[v.id] || [];
      const curU = usageRate(uSnaps, now, BURN_WINDOW_MS);
      if (curU) {
        const baseU = usageBaseline(uSnaps, now);
        const nk = `burn-spike|${v.id}`;
        const isSpikeU = baseU !== null && baseU > 0 && curU.rate > baseU * BURN_SPIKE_FACTOR;
        const isAbsoluteU = curU.consumed >= BURN_ABS_HOURLY;
        await pushBurnAlert(state, v, nk, curU, baseU, isSpikeU, isAbsoluteU, true);
        continue; // 官方数可用时不再走水位相减
      }
    }
    const snaps = state.burn[v.id] || [];
    // 🔴 2026-10-15：cur 用剔除官方结算跳变后的口径判警（老大骂 240 分假警报）；
    // 基线也用剔除口径，防止基线被结算跳变污染。
    const cur = burnRate(snaps, now, BURN_WINDOW_MS, true);
    if (!cur) continue;
    const base = burnBaseline(snaps, now, true);
    const nk = `burn-spike|${v.id}`;
    // 🔴 两级告警（2026-10-14 老大实测教训）：
    //   ① 相对基线：速率超基线 3 倍 → 报（平时异常）
    //   ② 绝对阈值：1 小时烧超 BURN_ABS_HOURLY 分 → 必报（基线被高消耗拉高时兜底，防"恢复正常"假豁免）
    const isSpike = base !== null && base > 0 && cur.rate > base * BURN_SPIKE_FACTOR;
    const isAbsolute = cur.consumed >= BURN_ABS_HOURLY;
    // 🔴 限频逻辑（2026-10-14 老大截图抓包）：老代码水位存的是积分值，积分一直在降
    // 导致每轮都判定"新的异常"，40 分钟内发了 4 条一模一样告警。改成"告警期间只发一次，
    // 10 分钟内最多补发一条"——水位存时间戳，不存会变化的积分值。
    await pushBurnAlert(state, v, nk, cur, base, isSpike, isAbsolute, false);
  }
}

/** 今天烧得最多的 top N 模型（记账+倍率换算）——告警里"谁在烧"的数据源 */
function topBurners(n = 3) {
  try {
    const usageFile = join(HERE, 'logs', 'usage-log.json');
    const j = JSON.parse(readFileSync(usageFile, 'utf8'));
    // 倍率表（2026-10-13 官方页核对过）：免费=0，付费按官网价
    const RATES = { 'glm-5.3-flash': 0.06, 'glm-5.3': 0.79, 'glm-5.2': 0.79, 'hy3': 0, 'hy3-intl': 0, 'hy4-preview': 0.29, 'step-5-preview': 0, 'step-5-preview-intl': 0, 'deepseek-v4.1-flash': 0.11, 'deepseek-v4.1-flash-intl': 0, 'deepseek-v4-pro': 0.51, 'kimi-k3-1': 1.62, 'kimi-k3-2': 1.62, 'minimax-m3': 0.25, 'space-bunny': 0.08 };
    return Object.entries(j.models ?? {})
      .map(([id, m]) => {
        const rate = RATES[id] ?? 0.06;
        // token → 积分粗算：WorkBuddy 官方口径约 1 分 = 1 万 token 费率 1x，即 credits ≈ tokens/10000*rate
        const credits = m.tokens / 10000 * rate;
        return { name: id, tokens: m.tokens, requests: m.requests, rate, credits };
      })
      .sort((a, b) => b.credits - a.credits || b.tokens - a.tokens)
      .slice(0, n);
  } catch { return []; }
}

function fmtK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// ── P0-2 每日摘要 ────────────────────────────────────
/**
 * 每天早上 DAILY_SUMMARY_HOUR 点推一条私聊：昨天烧了多少/剩多少、
 * 哪个模型几天后到期、昨天有无异常。只推一次（state.dailySummaryDate 去重）。
 */
const DAILY_SUMMARY_HOUR = Number(process.env.DAILY_SUMMARY_HOUR || 8); // 早 8 点
const DAILY_SUMMARY_MIN = Number(process.env.DAILY_SUMMARY_MIN || 0);

async function maybeDailySummary(state, variants) {
  const now = new Date();
  const hhmm = now.getHours() * 60 + now.getMinutes();
  const target = DAILY_SUMMARY_HOUR * 60 + DAILY_SUMMARY_MIN;
  if (hhmm < target || hhmm > target + 10) return; // 只在目标时段±10分钟内发
  const today = localDate(now);
  if (state.dailySummaryDate === today) return;
  state.dailySummaryDate = today;
  // 昨天消耗
  const lines = ['☀️ 早安，这是昨天的账：'];
  for (const v of variants) {
    if (typeof v.credits !== 'number') continue;
    const snaps = (state.burn?.[v.id] || []);
    const dayAgo = now.getTime() - 86400000;
    const ySnaps = snaps.filter((s) => s.t <= dayAgo && s.t > dayAgo - 86400000);
    let consumed = null;
    // 优先官方账：usage 时间线（used 只增）昨天的增量
    const uSnaps = (state.usage?.[v.id] || []);
    const uFrom = dayAgo - 86400000, uTo = dayAgo;
    const uWin = uSnaps.filter((s) => s.t <= uTo && s.t > uFrom);
    if (uWin.length >= 2) consumed = uWin[uWin.length - 1].used - uWin[0].used;
    if (consumed === null && ySnaps.length >= 2) {
      consumed = ySnaps[0].total - ySnaps[ySnaps.length - 1].total;
      const JUMP = BURN_ABS_HOURLY / 2;
      for (let i = 1; i < ySnaps.length; i++) {
        const d = ySnaps[i - 1].total - ySnaps[i].total;
        if (d > JUMP) consumed -= d;
      }
      if (consumed < 0) consumed = 0;
    }
    if (consumed === null) consumed = 0;
    // 🔴 2026-10-15 老大钦定（二改）：摘要明细与告警/看板同口径 = 官方按模型聚合。
    // 昨天的数据在磁盘缓存（昨天已是"历史日期"），直接读文件，不打工官方。
    let modelLines = [];
    try {
      const yday = new Date(now.getTime() - 86400000);
      const p2 = (n) => String(n).padStart(2, '0');
      const yKey = `${yday.getFullYear()}-${p2(yday.getMonth() + 1)}-${p2(yday.getDate())}`;
      const fp = join(HERE, 'logs', 'usage-cache', `${yKey}.json`);
      if (existsSync(fp)) {
        const j = JSON.parse(readFileSync(fp, 'utf8'));
        const mine = (j?.variants || []).find((x) => x.id === v.id);
        if (mine?.models?.length) {
          modelLines = ['  昨天谁在烧（官方账按模型）：',
            ...mine.models.filter((m) => m.credit > 0).slice(0, 3)
              .map((m) => `  · ${m.name}：${m.credit} 分（${m.requests} 次）`)];
        }
      }
    } catch { /* 明细缺就只报总数 */ }
    lines.push(`· ${v.id === 'workbuddy' ? '国内版' : '国际版'}：昨天烧 ${Math.round(consumed)} 分，现在剩 ${v.credits} 分`,
      ...modelLines);
  }
  // 快到期
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const soon = (cfg.entries ?? []).filter((e) => e.expiry && e.autoRetire)
    .map((e) => ({ e, left: new Date(e.expiry).getTime() - Date.now() }))
    .filter((x) => x.left > 0 && x.left < 14 * 86400000)
    .sort((a, b) => a.left - b.left);
  if (soon.length) {
    lines.push(`⏰ 14 天内到期：${soon.map((x) => `${x.e.model}（${humanLeft(x.left)}）`).join('、')}`);
  } else {
    lines.push('⏰ 14 天内没有限免到期。');
  }
  // 昨天异常
  const alertCount = Object.keys(state.burnAlert || {}).length;
  lines.push(alertCount > 0 ? `⚠️ 有 ${alertCount} 个烧速异常还没解除，注意查。` : '✅ 昨天无异常。');
  try { await sendText(lines.join('\n'), 'daily-summary', { variants: variants.map((v) => ({ id: v.id, credits: v.credits })) }); log('每日摘要已推送'); }
  catch (e) { state.dailySummaryDate = undefined; log('每日摘要推送失败（明早重试）:', String(e).slice(0, 120)); }
}

async function main() {
  if (!APP_ID || !APP_SECRET) {
    console.error('[free-expiry] 缺 LARK 凭据，退出');
    process.exit(1);
  }
  log(`启动：登记表 ${cfg_count()} 条，每 ${POLL_MS / 1000}s 一轮，私聊 open_id=${AT_OPEN_ID.slice(0, 14)}…`);
  const state = loadState();
  let round = 0;
  while (!stopping) {
    round++;
    try { await pollOnce(state); saveState(state); log(`第 ${round} 轮完成`); }
    catch (e) { log(`第 ${round} 轮异常（下轮继续）:`, String(e).slice(0, 200)); }
    await new Promise((resolve) => {
      wake = resolve;
      // 🔴 不能 unref()：unref 的 timer 不阻止进程退出，事件循环一空 node 就退了
      // （表现为服务起不来、exit=0、无报错）。2026-10-14 踩坑。
      timer = setTimeout(() => { wake = null; timer = null; resolve(); }, POLL_MS);
    });
  }
  log('退出');
}
function cfg_count() {
  try { return (JSON.parse(readFileSync(CONFIG, 'utf8')).entries ?? []).length; } catch { return 0; }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号');
    stopping = true;
    if (timer) clearTimeout(timer);
    if (wake) { const w = wake; wake = null; w(); }
  });
}

main().catch((e) => { console.error('[free-expiry] 致命:', e); process.exit(1); });
