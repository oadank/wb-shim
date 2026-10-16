/**
 * wb-shim 常驻服务（2026-10-08 · 方案 C · 老大钦定）
 *
 * 把 dsh-workbuddy-connect@0.7.1 的 loopback shim 变成固定端口的常驻
 * OpenAI 兼容端点，给 litellm 当上游 → agents-to-feishu 全部 bot 可用
 * workbuddy 模型（引擎/工具不动，只换模型）。
 *
 * 组装逻辑照抄插件源码 index.js:1914 createVariantRuntime + apply 的目录轮询。
 * atRestKeyProviderFor（加密凭据钥匙提供器）未公开导出，从分块文件按名导入；
 * 插件版本锁死 0.7.1（package.json），升级需同步核对分块文件名。
 */
import {
  CN_VARIANT,
  WORKBUDDY_VARIANTS,
  WorkBuddyUpstreamClient,
  WorkBuddyCredentialStore,
  WorkBuddyCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_AI_MODELS,
  createWorkBuddyShim,
} from 'dsh-workbuddy-connect';

import { execSync } from 'node:child_process';

// 未导出（exports 地图挡了子路径）→ 按 file URL 直 import 分块文件，绕过 exports；
// 解析 URL 与主包内部引用一致 ⇒ 同一模块实例。`b` 是 0.7.1 的压缩导出名
// （index.js:1 `import { b as atRestKeyProviderFor }`），升级需核对。
const chunkHB = await import(
  new URL('./host-heartbeat-L93zSVB5.js', import.meta.resolve('dsh-workbuddy-connect'))
);
const atRestKeyProviderFor = chunkHB.b;

const PORT = Number(process.env.WB_SHIM_PORT || 18796);
const HOST = process.env.WB_SHIM_HOST || '0.0.0.0';
const REFRESH_MS = Number(process.env.WB_SHIM_REFRESH_MS || 60 * 1000);
// 目录强制重抓间隔：登录态不变时 fetchModels 永远不跑，新上架模型（如限免的
// step-5-preview）要等服务重启才看得到。这里加一个兜底：目录超过这个年龄就
// 重抓一次，不管 uid 变没变。fetchModels 是只读列表，不烧积分。
const CATALOG_MAX_AGE_MS = Number(process.env.WB_SHIM_CATALOG_MAX_AGE_MS || 6 * 60 * 60 * 1000);
// 积分告警阈值：低于此值在 /alerts 端点和日志里喊（env 可调，0=关）。
const CREDITS_ALERT_BELOW = Number(process.env.WB_SHIM_CREDITS_ALERT_BELOW || 200);
// [2026-10-15 dsh] usage-detail 缓存（key=YYYY-MM-DD；历史日期永久缓存，今天 60s TTL）
const usageCache = new Map();
function todayStr() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
// [2026-10-15 dsh] 官方账拉取+聚合（/usage-detail 与预取共用）
async function fetchUsageDay(day) {
  const results = await Promise.all(live.map(async (r) => {
    try {
      const cred = await r.store.resolve();
      const isIntl = r.variant.id !== CN_VARIANT.id;
      const base = isIntl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
      const headers = { 'Authorization': `Bearer ${cred.accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      if (cred.domain) headers['X-Domain'] = cred.domain;
      const agg = {}; let total = 0; let fetched = 0; let pageNum = 1;
      for (; pageNum <= 50; pageNum++) {
        const resp = await fetch(`${base}/billing/meter/get-user-request-usage`, {
          method: 'POST', headers,
          body: JSON.stringify({ startTime: `${day} 00:00:00`, endTime: `${day} 23:59:59`, pageNum, pageSize: 200 }),
          signal: AbortSignal.timeout(15000),
        });
        const j = await resp.json();
        const rows = j?.data?.data;
        if (!Array.isArray(rows)) break;
        fetched += rows.length;
        for (const row of rows) {
          const m = agg[row.model] || (agg[row.model] = { credit: 0, requests: 0 });
          m.credit += Number(row.credit) || 0; m.requests += 1;
          total += Number(row.credit) || 0;
        }
        if (fetched >= (j?.data?.total || 0) || rows.length < 200) break;
      }
      const models = Object.entries(agg).map(([name, m]) => ({ name, credit: Math.round(m.credit * 100) / 100, requests: m.requests })).sort((a, b) => b.credit - a.credit);
      return { id: r.variant.id, day, total: Math.round(total * 100) / 100, requests: fetched, models };
    } catch (e) { return { id: r.variant.id, error: String(e).slice(0, 150) }; }
  }));
  return { ok: true, day, variants: results };
}

function usageCacheDir() { const dir = join(HERE, 'logs', 'usage-cache'); if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); return dir; }
// 单飞：同一天并发请求共享同一次官方拉取（防告警+看板刷新撞车重复打 API/排队超时）
const usageInflight = new Map();
// [2026-10-15 workbuddy] usage-recent 时间窗查询的 5s 缓存与单飞（每轮消耗显示用）
const usageRecentCache = new Map();
const usageRecentInflight = new Map();
async function getUsageDayCached(day) {
  const isToday = day === todayStr();
  const memHit = usageCache.get(day);
  if (memHit && (!isToday || Date.now() - memHit.at < 60000)) return memHit.data;
  if (!memHit) {
    try {
      const diskPath = join(usageCacheDir(), `${day}.json`);
      if (existsSync(diskPath)) { const d = JSON.parse(readFileSync(diskPath, 'utf8')); usageCache.set(day, { at: Date.now(), data: d }); return d; }
    } catch { }
  }
  let p = usageInflight.get(day);
  if (!p) {
    p = fetchUsageDay(day).then((payload) => {
      usageCache.set(day, { at: Date.now(), data: payload });
      try { writeFileSync(join(usageCacheDir(), `${day}.json`), JSON.stringify(payload)); } catch { }
      usageInflight.delete(day);
      return payload;
    }).catch((e) => { usageInflight.delete(day); throw e; });
    usageInflight.set(day, p);
  }
  return p;
}

// [2026-10-15 dsh] 每请求即时 credit 日志：上游聊天响应 usage 自带 "credit" 字段
// （实测与官方 get-user-request-usage 精确相等：hy3-x 3487 tokens → 双边都是 0.3 分），
// 零延迟，不等官方 1~2 分钟入账。dsh-web 每轮消耗 pill 的即时数据源就靠它。
const creditLog = [];
const creditLogFile = () => join(HERE, 'logs', 'credit-log.jsonl');
function recordCredit(model, usage) {
  try {
    const credit = Number(usage?.credit);
    if (!Number.isFinite(credit)) return;
    const e = {
      t: Date.now(),
      model: String(model || ''),
      credit,
      prompt_tokens: Number(usage?.prompt_tokens) || 0,
      completion_tokens: Number(usage?.completion_tokens) || 0,
    };
    creditLog.push(e);
    if (creditLog.length > 5000) creditLog.splice(0, creditLog.length - 5000);
    appendFileSync(creditLogFile(), JSON.stringify(e) + '\n');
  } catch { }
}
// 启动时从 jsonl 回灌（只留最近 5000 条，文件超限截断重写防无限膨胀）
function loadCreditLog() {
  try {
    const fp = creditLogFile();
    if (!existsSync(fp)) return;
    const raw = readFileSync(fp, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    if (lines.length > 5000) {
      const keep = lines.slice(-5000);
      try { writeFileSync(fp, keep.join('\n') + '\n'); } catch { }
      creditLog.push(...keep.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      log(`credit-log 回灌 ${keep.length} 条（已截断）`);
      return;
    }
    creditLog.push(...lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    log(`credit-log 回灌 ${creditLog.length} 条`);
  } catch (e) { log('credit-log 回灌失败:', String(e).slice(0, 120)); }
}

// 启动后台预取最近 7 天（跳过磁盘已有）：老大钦定"历史全拉齐"，不是挑着拉
async function prefetchRecentUsage() {
  const days = [];
  for (let i = 1; i <= 7; i++) { const d = new Date(); d.setDate(d.getDate() - i); const p = (n) => String(n).padStart(2, '0'); days.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`); }
  for (const day of days) {
    const fp = join(usageCacheDir(), `${day}.json`);
    if (existsSync(fp)) continue;
    try { const payload = await fetchUsageDay(day); writeFileSync(fp, JSON.stringify(payload)); usageCache.set(day, { at: Date.now(), data: payload }); log(`预取 ${day} 完成（${payload.variants.map((v) => `${v.id}:${v.total}分`).join(' ')}）`); }
    catch (e) { log(`预取 ${day} 失败:`, String(e).slice(0, 120)); }
  }
  log('近期官方账预取完成');
}

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, readEvents } from './events.mjs';
import { recordUsage, recordLimit } from './usage-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const existsSyncProb = existsSync;

// token：env > token.txt（与 daemon 同目录）> 旧默认（仅过渡，打警告）
function loadToken() {
  if (process.env.WB_SHIM_TOKEN) return { token: process.env.WB_SHIM_TOKEN, src: 'env' };
  try {
    const t = readFileSync(new URL('./token.txt', import.meta.url), 'utf8').trim();
    if (t) return { token: t, src: 'token.txt' };
  } catch { /* 无文件走默认 */ }
  return { token: 'wb-shim-CHANGEME', src: 'legacy-default(请尽快写 token.txt)' };
}
const { token: TOKEN, src: TOKEN_SRC } = loadToken();

const log = (...a) => console.log(new Date().toISOString(), '[wb-shim]', ...a);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-');

// 插件推理档位检测记录（~/.dsh/.workbuddy-probe.json v2，按账号分组）——只读展示，本服务不主动探测
function probeEffortsFor(modelId, uid) {
  try {
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
    const j = JSON.parse(readFileSync(join(home, '.workbuddy-probe.json'), 'utf8'));
    if (j.version !== 2 || !j.records) return null;
    const pick = (bucket) => {
      const rec = bucket?.[modelId];
      return rec && rec.validation === 'validating' && Array.isArray(rec.efforts) && rec.efforts.length ? rec.efforts.join('/') : null;
    };
    if (uid && j.records[uid]) { const r = pick(j.records[uid]); if (r) return r; }
    for (const bucket of Object.values(j.records)) { const r = pick(bucket); if (r) return r; }
    return null;
  } catch { return null; }
}

/** 照抄插件 index.js:1910 fallbackFor：启动期/离线期的内置目录。 */
const fallbackFor = (variant) =>
  variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS;

/** 照抄 createVariantRuntime（index.js:1914），砍掉探测/显隐这两个 UI 专用件。 */
function buildRuntime(variant) {
  const client = new WorkBuddyUpstreamClient();
  const store = new WorkBuddyCredentialStore({
    variant,
    keyProvider: atRestKeyProviderFor(variant),
    refresh: (credential) => client.refreshToken(credential),
  });
  const catalog = new WorkBuddyCatalog(fallbackFor(variant));
  // 用上游声明的最大上下文窗口（国际版目录带 supportedContextWindows 多档时取最大；
  // 插件卡片的同名开关默认也是开的）。国内版目录多为单档，无副作用。
  catalog.setUseMaximumContextWindow(true);
  catalog.setVisible(false);
  return { variant, client, store, catalog, lastIdentity: undefined, inFlight: undefined, credits: undefined, creditsAtMs: 0, creditsError: undefined };
}

/** 抓积分（照抄 apply 的账号轮询：fetchCredits(credential)）。失败保留旧值，error 记原因。 */
async function refreshCredits(rt, credential) {
  try {
    const c = await rt.client.fetchCredits(credential);
    rt.credits = c;
    rt.creditsAtMs = Date.now();
    // [2026-10-15 dsh] 官方周期用量快照（按包 CycleCapacityUsed）：烧速告警/摘要的"烧了多少"直接用这个官方数，
    // 不再拿水位相减或 token 粗算。记录每次抓取形成官方用量时间线。
    rt.usageHistory = rt.usageHistory || [];
    const usedTotal = (c.accounts || []).reduce((s, a) => s + (a.cycleUsed || 0), 0);
    rt.usageHistory.push({ t: Date.now(), used: usedTotal });
    if (rt.usageHistory.length > 2016) rt.usageHistory = rt.usageHistory.slice(-2016); // 7天×2分钟粒度
    rt.creditsError = undefined;
    log(rt.variant.id, `积分: total=${c.unlimited ? '不限' : c.total} accounts=${c.accounts?.length ?? 0}`);
    // 积分低水位告警：低于阈值喊一次（值变了才重复喊，不刷屏）
    if (!c.unlimited && CREDITS_ALERT_BELOW > 0 && c.total < CREDITS_ALERT_BELOW && rt._lowCreditWarned !== c.total) {
      rt._lowCreditWarned = c.total;
      rt.alerts = rt.alerts || [];
      rt.alerts.push({ t: Date.now(), kind: 'credits-low', total: c.total });
      appendEvent('credits-low', { variant: rt.variant.id, total: c.total, note: `积分低于 ${CREDITS_ALERT_BELOW}，主力腿即将开始烧钱或断供` });
      log(rt.variant.id, `🔴 积分低水位: ${c.total} < ${CREDITS_ALERT_BELOW} → 主力腿即将开始烧钱或断供`);
    }
    if (!c.unlimited && c.total >= CREDITS_ALERT_BELOW) rt._lowCreditWarned = undefined;
  } catch (e) {
    rt.creditsError = String(e);
    log(rt.variant.id, '积分抓取失败:', String(e));
  }
}

/**
 * 免费状态翻转检测（2026-10-13 加）：限免模型（step-5-preview / hy3 / dsv4.1f-intl 等）
 * 随时可能到期变收费或直接下架。每次目录变化时对比"免费模型名单"快照：
 *   - 名单变短 → 有限免到期/被撤，告警（主力腿可能正在烧钱）
 *   - 名单变长 → 有新白嫖上线，也喊一声（错过就是亏）
 * 只在目录重抓后调用，零额外请求。
 * 🔴 free 字段的两种形状都要认：fetchModels 原始对象是 billing.free；
 * 插件 status 文档加工后才扁平化成顶层 free（见插件 lib/index.js workBuddyWebStatus）。
 */
function isFreeModel(m) {
  return m?.free === true || m?.billing?.free === true;
}
/**
 * 目录变化检测（2026-10-15 瘦身版）：目录重抓后对比全量模型名单，
 * 增/减都记时间线事件（model-added / model-removed）——这就是"刷新主页模型
 * 新增与减少"的份内自动化。限免名单翻转额外记 rt.alerts（/alerts 端点用）。
 */
function detectCatalogChanges(rt, models) {
  const nowIds = (models ?? []).map((m) => m.id).sort();
  const prevIds = rt.modelIds;
  rt.modelIds = nowIds;
  if (!prevIds) return; // 首轮建基线，不记事件
  const removed = prevIds.filter((id) => !nowIds.includes(id));
  const added = nowIds.filter((id) => !prevIds.includes(id));
  if (removed.length) appendEvent('model-removed', { variant: rt.variant.id, models: removed });
  if (added.length) appendEvent('model-added', { variant: rt.variant.id, models: added });
  if (added.length || removed.length) log(rt.variant.id, `目录变化：+${added.length} / -${removed.length}${added.length ? ' 增: ' + added.join(', ') : ''}${removed.length ? ' 减: ' + removed.join(', ') : ''}`);

  // 限免翻转（免费名单变短=到期/被撤，变长=新白嫖上线）→ rt.alerts 给 /alerts
  const nowFree = (models ?? []).filter(isFreeModel).map((m) => m.id).sort();
  const prevFree = rt.freeIds;
  rt.freeIds = nowFree;
  if (!prevFree) return;
  const gone = prevFree.filter((id) => !nowFree.includes(id));
  const addedFree = nowFree.filter((id) => !prevFree.includes(id));
  if (gone.length) {
    rt.alerts = rt.alerts || [];
    rt.alerts.push({ t: Date.now(), kind: 'free-gone', ids: gone });
    log(rt.variant.id, `🔴 限免到期/被撤: ${gone.join(', ')}（注意别在收费模型上白烧积分）`);
  }
  if (addedFree.length) {
    rt.alerts = rt.alerts || [];
    rt.alerts.push({ t: Date.now(), kind: 'free-added', ids: addedFree });
    log(rt.variant.id, `🟢 新白嫖上线: ${addedFree.join(', ')}`);
  }
}

/** 目录轮询（缩自 apply 的 sweep）：登录态变化 → fetchModels → 目录生效。 */
async function sweep(rt) {
  let status;
  try {
    status = await rt.store.status();
  } catch (e) {
    log(rt.variant.id, 'status 读取失败:', String(e));
    return;
  }
  if (status.state !== 'signed-in') {
    if (rt.lastIdentity !== undefined || rt.catalog.isVisible()) {
      log(rt.variant.id, '未登录，目录隐藏 (reason=', status.reason ?? '-', status.reasonCode ?? '-', ')');
      rt.lastIdentity = undefined;
      rt.catalog.setVisible(false);
    }
    return;
  }
  let identity, credential;
  try {
    credential = await rt.store.resolve();
    identity = credential.uid ?? 'signed-in';
    rt.accountInfo = { uid: credential.uid, nickname: credential.nickname, domain: credential.domain };
  } catch (e) {
    log(rt.variant.id, '凭据 resolve 失败（下一轮重试）:', String(e));
    return;
  }
  if (identity === rt.lastIdentity && rt.catalog.isVisible()) {
    // 登录态没变：积分便宜，每轮顺手刷
    if (Date.now() - rt.creditsAtMs > REFRESH_MS) await refreshCredits(rt, credential);
    // 但目录超龄仍强制重抓：上游会新上架模型（限免窗口不等人），
    // 只等 uid 变化的话新模型永远进不来。
    if (rt.catalogAtMs && Date.now() - rt.catalogAtMs > CATALOG_MAX_AGE_MS) {
      log(rt.variant.id, '目录超龄，强制重抓…');
      try {
        const models = await rt.client.fetchModels(credential);
        rt.catalog.set([...models]);
        rt.catalogAtMs = Date.now();
        log(rt.variant.id, `目录重抓生效：${models.length} 个模型 [${models.map((m) => m.id).join(', ')}]`);
        detectCatalogChanges(rt, models);
      } catch (e) {
        log(rt.variant.id, '目录重抓失败（下一轮重试）:', String(e));
      }
    }
    return;
  }
  log(rt.variant.id, '登录态生效，刷新模型目录…');
  if (rt.inFlight) rt.inFlight.abort();
  rt.inFlight = new AbortController();
  try {
    const models = await rt.client.fetchModels(await rt.store.resolve(), rt.inFlight.signal);
    rt.catalog.set([...models]);
    rt.catalog.setVisible(true);
    rt.lastIdentity = identity;
    rt.catalogAtMs = Date.now();
    log(rt.variant.id, `目录生效：${models.length} 个模型 [${models.map((m) => m.id).join(', ')}]`);
    detectCatalogChanges(rt, models);
    await refreshCredits(rt, credential);
  } catch (e) {
    log(rt.variant.id, '目录刷新失败:', String(e));
  }
}

const runtimes = WORKBUDDY_VARIANTS.map(buildRuntime);

for (const rt of runtimes) {
  const shim = createWorkBuddyShim({ store: rt.store, client: rt.client, catalog: rt.catalog, logger: console });
  try {
    await shim.ready;
  } catch (e) {
    log(`${rt.variant.displayName} shim 启动失败:`, String(e));
    continue;
  }
  rt._pluginShim = shim;
  await sweep(rt).catch((e) => log(`${rt.variant.id} 首轮 sweep 异常:`, String(e)));
}

// 反代：固定端口 18796 + 固定 token → 各 variant 的随机端口 shim
import http from 'node:http';
// 协议适配层（2026-10-15 老大令）：Anthropic Messages / OpenAI Responses → chat/completions
import {
  anthropicToChat,
  responsesToChat,
  aggregateSseToChat,
  chatToAnthropicSSE,
  chatToResponsesSSE,
  chatToAnthropicJson,
  chatToResponsesJson,
} from './proto-convert.mjs';

const live = runtimes.filter((rt) => rt._pluginShim);
if (!live.length) {
  console.error('[wb-shim] 没有任何 variant 启动成功，退出');
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════
// 二级页面「模型动态」数据层（2026-10-15 瘦身：只做份内的模型状态维护）
// 回答三个问题：① 模型现在什么状态 ② 状态变更时间线 ③ 各模块心跳
// 数据源：free-expiry.json（到期登记）+ rate-guard 状态 + events.jsonl 时间线 + 服务日志年龄
// 全部只读、免鉴权（不含任何令牌/key）
// ════════════════════════════════════════════════════════════════
const WB_DIR = HERE; // 与 daemon 同目录（C:\D\opt\wb-shim）
// 组名 → 上游模型名（与 rate-guard.mjs upstreamOf 同源；限流状态卡片/首页徽章用）
const GROUP_MODEL = {
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
function readJsonSafe(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** 免费模型 + 到期倒计时 */
function buildFreeModels() {
  const cfg = readJsonSafe(join(WB_DIR, 'free-expiry.json'), { entries: [] });
  const now = Date.now();
  return (cfg.entries ?? [])
    .filter((e) => e.expiry)
    .map((e) => {
      const exp = new Date(e.expiry).getTime();
      const left = exp - now;
      return {
        model: e.model,
        variant: e.variant,
        upstreamModel: e.upstreamModel,
        freeSince: e.freeSince,
        expiry: e.expiry,
        leftMs: left,
        leftText: humanLeftLocal(left),
        expired: left <= 0,
        autoRetire: e.autoRetire === true,
        inferred: e.inferred === true,
        evidence: e.evidence,
        contextWindow: e.contextWindow,
        freeWindow: e.freeWindow,
        note: e.note,
      };
    })
    .sort((a, b) => a.leftMs - b.leftMs);
}
function humanLeftLocal(ms) {
  if (ms <= 0) return '已到期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  return `${m} 分钟`;
}

/** 下次自动动作预告（瘦身版）：只剩份内的两件事——到期登记、限流恢复探测 */
function buildSchedule() {
  const out = [];
  const cfg = readJsonSafe(join(WB_DIR, 'free-expiry.json'), { entries: [] });
  const rg = readJsonSafe(join(WB_DIR, '.rate-guard-state.json'), {});

  // 1) 到期自动标记
  for (const e of cfg.entries ?? []) {
    if (!e.expiry) continue;
    const exp = new Date(e.expiry).getTime();
    if (exp <= Date.now()) continue;
    out.push({
      at: exp, kind: 'expiry-retire',
      text: `${e.model}（${e.variant}）免费到期 → 标记"已到期"并记时间线`,
      auto: true,
    });
    // 预告时间点
    for (const mins of e.notifyBeforeMinutes ?? []) {
      const t = exp - mins * 60000;
      if (t > Date.now()) {
        out.push({ at: t, kind: 'expiry-notice', text: `${e.model} 到期前 ${mins >= 1440 ? Math.round(mins / 1440) + ' 天' : Math.round(mins / 60) + ' 小时'}预告（记时间线）`, auto: true });
      }
    }
  }
  // 2) rate-guard 限流恢复探测
  for (const [group, st] of Object.entries(rg)) {
    if (st?.status === 'rate-limited' && st.resetAt) {
      out.push({ at: st.resetAt, kind: 'rate-probe', text: `${group} 限流重置 → 自动探测是否恢复，恢复记时间线`, auto: true });
    }
  }
  return out.filter((x) => x.at > Date.now()).sort((a, b) => a.at - b.at).slice(0, 25);
}

/** 服务健康（双证据：日志活跃度 + 进程锁）
 * 🔴 教训：① 不能只看日志——有些模块没活干时静默几分钟很正常；
 *   ② 不能只查进程——PowerShell 里 Get-Process/Get-CimInstance 在这个服务环境下
 *   匹配 CommandLine 极不可靠（2026-10-14 踩过多次）。
 * 折中：日志年龄 < 阈值 = 活跃；超过阈值再尝试用文件锁判断进程是否还在。
 */

/** 查 nssm 服务是否真在跑（比日志年龄可靠）：sc query 输出含 RUNNING 即活 */
function svcRunning(name) {
  try {
    const out = execSync(`sc query "${name}"`, { windowsHide: true, timeout: 5000 }).toString();
    return /STATE\s*:\s*\d+\s+RUNNING/.test(out);
  } catch { return false; }
}

function buildHealth() {
  const svcs = [
    { name: 'wb-shim', log: 'logs\\stderr.log', maxQuietMin: 30 },
    { name: 'free-expiry', log: 'logs\\free-expiry-stdout.log', maxQuietMin: 15 },
    { name: 'rate-guard', log: 'logs\\rate-guard-stdout.log', maxQuietMin: 120 },
    { name: 'promo-sync', log: 'logs\\promo-sync-stdout.log', maxQuietMin: 90 },
  ];
  return svcs.map((s) => {
    let mtime = 0;
    try { mtime = statSync(join(WB_DIR, s.log)).mtimeMs; } catch {}
    const ageMs = mtime ? Date.now() - mtime : null;
    const quietMin = ageMs === null ? null : Math.round(ageMs / 60000);
    return {
      name: s.name,
      lastLogAt: mtime || null,
      lastLogText: mtime ? new Date(mtime).toLocaleString('zh-CN', { hour12: false }) : '无日志',
      alive: svcRunning(s.name),
      quietMin,
      maxQuietMin: s.maxQuietMin,
    };
  });
}

/** rate-guard 当前状态（瘦身版：status 只有 ok / rate-limited 两种） */
function buildRateState() {
  const rg = readJsonSafe(join(WB_DIR, '.rate-guard-state.json'), {});
  const list = Object.entries(rg).map(([group, st]) => ({
    group,
    model: st?.model ?? GROUP_MODEL[group] ?? null,
    status: st?.status ?? 'ok',
    statusText: st?.status === 'rate-limited' ? '被限流（哨兵盯着，到点自动探测恢复）' : '正常',
    since: st?.since ?? null,
    resetAt: st?.resetAt ?? null,
    resetText: st?.resetAt ? new Date(st.resetAt).toLocaleString('zh-CN', { hour12: false }) : null,
  }));
  // 🔴 按上游模型去重：同一 model 的多个 litellm 组名（如 wb-st5pcn / wb-step5 同指 step-5-preview）
  // 只显示一行，模型名用 modelCn 映射（不暴露 litellm 内部组名）。多组都限流则取较晚的预计恢复。
  const byModel = new Map();
  for (const r of list) {
    const key = r.model || r.group;
    const prev = byModel.get(key);
    if (!prev) { byModel.set(key, r); continue; }
    if (r.status !== 'rate-limited') continue;
    if (prev.status !== 'rate-limited' || (r.resetAt || 0) > (prev.resetAt || 0)) byModel.set(key, r);
  }
  return [...byModel.values()];
}

function buildRouterData() {
  // 官方促销数据源新鲜度：wb-product-config.json 是 WorkBuddy 客户端自动拉的官方配置，
  // promo-sync 每 30 分钟读它更新登记表。这里展示"官方数据什么时候拉的"。
  let promoSource = null;
  try {
    const root = 'C:\\Users\\oadan\\.workbuddy\\storage';
    let best = null;
    for (const user of readdirSync(root)) {
      const scoped = join(root, user, 'scoped');
      if (!existsSyncProb(scoped)) continue;
      for (const hash of readdirSync(scoped)) {
        const f = join(scoped, hash, 'wb-product-config.json');
        if (!existsSyncProb(f)) continue;
        const m = statSync(f).mtimeMs;
        if (!best || m > best.mtime) best = { file: f, mtime: m };
      }
    }
    if (best) {
      let promoCount = 0;
      try { promoCount = (JSON.parse(readFileSync(best.file, 'utf8'))['product-config-snapshot']?.data?.modelPromotions ?? []).length; } catch {}
      promoSource = { file: best.file, mtime: best.mtime, mtimeText: new Date(best.mtime).toLocaleString('zh-CN', { hour12: false }), promos: promoCount };
    }
  } catch {}
  return {
    ok: true,
    now: Date.now(),
    nowText: new Date().toLocaleString('zh-CN', { hour12: false }),
    freeModels: buildFreeModels(),
    schedule: buildSchedule(),
    health: buildHealth(),
    rateState: buildRateState(),
    events: readEvents(120),
    promoSource,
    credits: live.map((r) => ({ id: r.variant.id, total: r.credits?.unlimited ? '不限' : (r.credits?.total ?? null) })),
  };
}

/** 二级页面 HTML（纯内联，无外部依赖；JS 每 60 秒拉 /api/router 刷新）
 * 🔴 文案铁律（2026-10-14 老大令"不是大白话"）：每个字过一遍"老大能看懂吗"——
 *   不用"deployment/weight/fallback/探针/inferred"这类术语；
 *   机器人说"bot"，模型说名字，动作说人话（"挪走/顶上/撑到几点"）。
 */
function renderUsagePage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>积分明细 · wb-shim</title><style>
:root{--brand:#FD9527;--bg:#FFF;--border:#DDD;--surface:#F5F5F5;--text:#333;--text2:#666;--text3:#999;--ok:#0f7b46;--err:#c0392b;--font-mono:'IBM Plex Mono',ui-monospace,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#111;--border:#333;--surface:#1b1b1b;--text:#eee;--text2:#aaa;--text3:#777;--ok:#4ade80;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;padding:1.2rem 1.4rem 3rem;font:14px/1.55 -apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text)}
h1{font-size:1.05rem;margin:0 0 .3rem}.sub{color:var(--text3);font-size:.78rem;margin-bottom:1rem}
.datebar{display:flex;gap:.5rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap}
.datebar input[type=date]{padding:.3rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit}
.datebar button{padding:.3rem .8rem;border:1px solid var(--border);border-radius:6px;background:var(--brand);color:#fff;border:none;cursor:pointer;font:inherit}
.datebar button.ghost{background:var(--surface);color:var(--text)}
table{border-collapse:collapse;width:100%;margin-top:.6rem}
th{position:sticky;top:0;background:var(--surface);text-align:left;padding:.4rem .6rem;font-size:.72rem;color:var(--text3);border-bottom:1px solid var(--border);text-transform:uppercase;cursor:pointer;user-select:none}
td{padding:.42rem .6rem;border-bottom:1px solid var(--border)}
tr:hover td{background:var(--surface)}
.num{font-family:var(--font-mono);text-align:right}
.card{border:1px solid var(--border);border-radius:10px;padding:.8rem 1rem;margin-bottom:1.2rem}
.card h2{margin:0 0 .4rem;font-size:.95rem}.card .total{font-family:var(--font-mono);font-size:1.5rem;font-weight:700}
.err{color:var(--err);font-size:.85rem}
.free{color:var(--ok)}
</style></head><body>
<div style="margin-bottom:.6rem"><a href="/" style="color:var(--brand);text-decoration:none;font-size:.85rem">&#8592; 返回主页</a></div>
<h1>积分明细（官方账）</h1>
<div class="sub">数据源：官方 get-user-request-usage，按模型聚合。免费模型显示 0 分是官方口径（限免期不扣分）。⚠ 单日官方最多返回 3000 条（超量日为抽样聚合，当天 <3000 请求则为全量）。</div>
<div class="datebar">
  <input type="date" id="d">
  <button onclick="load()">查这一天</button>
  <button class="ghost" onclick="document.getElementById('d').value='';load()">今天</button>
  <button class="ghost" onclick="shift(-1)">← 前一天</button>
  <button class="ghost" onclick="shift(1)">后一天 →</button>
</div>
<div id="content">加载中…</div>
<script>
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function today(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function shift(n){const i=document.getElementById('d');const v=i.value?new Date(i.value+'T12:00:00'):new Date();v.setDate(v.getDate()+n);i.value=v.getFullYear()+'-'+String(v.getMonth()+1).padStart(2,'0')+'-'+String(v.getDate()).padStart(2,'0');load()}
async function load(){
  const el=document.getElementById('content');el.textContent='加载中…（当天首次拉取需 5~30 秒，之后秒开）';
  const d=document.getElementById('d').value||'';
  try{
    const j=await(await fetch('/usage-detail'+(d?'?date='+d:''),{cache:'no-store'})).json();
    if(!j.ok)throw new Error(j.error||'unknown');
    let html='';
    for(const v of j.variants){
      html+='<div class="card"><h2>'+esc(v.id)+(v.total>0?'':' <span class="free">✓ 免费</span>')+'</h2>';
      if(v.error){html+='<div class="err">拉取失败：'+esc(v.error)+'</div>'}
      else{
        html+='<div class="total">'+v.total+' 分 <span style="font-size:.8rem;color:var(--text3);font-weight:400">/ '+v.requests+' 次请求 · '+esc(v.day)+'</span></div>';
        if(v.models&&v.models.length){
          html+='<table><thead><tr><th>模型</th><th style="text-align:right">消耗（分）</th><th style="text-align:right">请求数</th></tr></thead><tbody>';
          for(const m of v.models){html+='<tr><td>'+esc(m.name)+'</td><td class="num">'+m.credit.toFixed(2)+'</td><td class="num">'+m.requests+'</td></tr>'}
          html+='</tbody></table>';
        } else { html+='<div class="sub">这一天没有调用记录。</div>' }
      }
      html+='</div>';
    }
    el.innerHTML=html;
  }catch(e){el.innerHTML='<div class="err">加载失败：'+esc(e.message)+'</div>'}
}
document.getElementById('d').value=today();
load();
</script></body></html>`;
}
/** 二级页面「模型动态」（2026-10-15 瘦身改名，原「自动化总览」）：
 * 只显示三块份内事：① 模型状态总览（免费到期 + 限流）② 状态变更时间线 ③ 模块心跳。
 * 数据全部来自 /api/router（events.jsonl + 两个哨兵状态 + 服务日志年龄）。
 * 🔴 文案铁律（2026-10-14 老大令）：每个字过一遍"老大能看懂吗"，不用术语。
 */
function renderRouterPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>模型动态 · wb-shim</title><style>
:root{--brand:#FD9527;--bg:#FFF;--border:#DDD;--surface:#F5F5F5;--text:#333;--text2:#666;--text3:#999;--ok:#0f7b46;--warn:#9a5b00;--err:#c0392b;--font-mono:'IBM Plex Mono',ui-monospace,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#111;--border:#333;--surface:#1b1b1b;--text:#eee;--text2:#aaa;--text3:#777;--ok:#4ade80;--warn:#fbbf24;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,'Segoe UI',system-ui,sans-serif;padding:0 0 3rem}
.wrap{max-width:1100px;margin:0 auto;padding:0 1rem}
header{padding:1.1rem 0 .5rem}.brand{font-weight:600;font-size:1.05rem}.brand b{color:var(--brand)}
.subtle{color:var(--text3);font-size:.76rem;display:block;margin-top:.15rem}
a.back{color:var(--brand);text-decoration:none;font-size:.82rem}
.card{border:1px solid var(--border);border-radius:9px;padding:.9rem 1rem;margin:.85rem 0;background:var(--surface)}
h2{margin:0 0 .3rem;font-size:1rem;font-weight:600;color:var(--text)}
h2 .q{font-size:.78rem;color:var(--text3);font-weight:400;display:block;margin-top:.1rem}
table{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:.5rem}
th{text-align:left;color:var(--text3);font-weight:400;font-size:.76rem;padding:.35rem .5rem;border-bottom:1px solid var(--border)}
td{padding:.5rem .5rem;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:.08rem .5rem;border-radius:99px;border:1px solid var(--border);font-size:.74rem;white-space:nowrap}
.pill.ok{color:var(--ok);border-color:var(--ok)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.pill.err{color:var(--err);border-color:var(--err)}
.mono{font-family:var(--font-mono);font-size:.8rem}
.muted{color:var(--text3)}
.note{color:var(--text3);font-size:.76rem;margin-top:.5rem;line-height:1.5}
.empty{padding:1.2rem;text-align:center;color:var(--text3);font-size:.82rem}
.bigline{font-size:.95rem;margin:.35rem 0}
.bigline b{color:var(--brand)}
.ev{white-space:pre-wrap;font-size:.82rem}
@media(max-width:600px){th:nth-child(n+4),td:nth-child(n+4){display:none}}
</style></head><body><div class="wrap">
<header>
  <div class="brand"><b>模型动态</b> · 模型上下架、限流、免费到期的记录与当前状态</div>
  <div class="subtle"><a class="back" href="/">← 回模型看板</a> · 每 60 秒自动刷新 · 更新于 <span id="now"></span></div>
</header>
<div id="content"><div class="card"><div class="empty">加载中…</div></div></div>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmtT(ms){if(!ms)return '-';const d=new Date(ms);const p=(n)=>String(n).padStart(2,'0');return (d.getMonth()+1)+'月'+d.getDate()+'日 '+p(d.getHours())+':'+p(d.getMinutes())}
function leftText(ms){if(ms<=0)return '已经到期了';const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4);if(d>0)return '还能用 '+d+' 天'+(h?' '+h+' 小时':'');if(h>0)return '还能用 '+h+' 小时'+(m?' '+m+' 分':'');return '还剩 '+m+' 分钟'}
function evText(e){
  const p=[];
  if(e.models&&e.models.length)p.push(e.models.join('、'));
  else if(e.model)p.push(e.model);
  if(e.variant)p.push('('+e.variant+')');
  if(e.leftText)p.push('还剩 '+e.leftText);
  if(e.expiryText)p.push('免费到 '+e.expiryText);
  if(e.resetAtText)p.push('预计 '+e.resetAtText+' 恢复');
  if(e.downForMin)p.push('限了 '+e.downForMin+' 分钟');
  if(e.total!=null)p.push('剩余 '+e.total+' 分');
  if(e.reason)p.push(e.reason);
  if(e.note)p.push(e.note);
  return p.join(' · ')||'-';
}
async function load(){
  let d;try{d=await(await fetch('/api/router',{cache:'no-store'})).json()}catch(e){document.getElementById('content').innerHTML='<div class="card"><div class="empty">加载失败：'+esc(e.message)+'</div></div>';return}
  document.getElementById('now').textContent=fmtT(d.now);
  const H=[];
  const modelCn={'step-5-preview':'阶跃 Step5（国内版）','step-5-preview-intl':'阶跃 Step5（国际版）','deepseek-v4.1-flash-intl':'DeepSeek v4.1 极速版（国际）','hy3':'腾讯混元 Hy3（国内）','hy3-intl':'腾讯混元 Hy3（国际）','hy4-preview':'腾讯混元 Hy4','glm-5.3-flash':'GLM 5.3 极速'};
  const mc=(m)=>modelCn[m]||m;

  /* ① 一句话总结 */
  const free=d.freeModels.filter(m=>!m.expired);
  const expired=d.freeModels.filter(m=>m.expired);
  const limited=(d.rateState||[]).filter(r=>r.status==='rate-limited');
  let sum;
  if(limited.length){
    const etaTxt = limited[0]?.resetAt ? fmtT(limited[0].resetAt)+' 左右恢复' : '恢复时间待哨兵拿到官方响应后更新';
    sum='⚠️ 有 '+limited.length+' 个模型正被官方限流：'+limited.map(l=>esc(mc(l.model||l.group))).join('、')+'，'+etaTxt+'，哨兵每 5 分钟自动探测。';
  }else if(free.length){
    const next=free.reduce((a,b)=>a.leftMs<b.leftMs?a:b);
    sum='✅ 一切正常。'+free.length+' 个免费模型都能用，其中 '+esc(mc(next.upstreamModel||next.model))+' 最早到期（'+leftText(next.leftMs)+'），到期前系统会记录并标记。';
  }else{
    sum='⚠️ 登记的免费模型全部到期了（详见下方状态表）。';
  }
  H.push('<div class="card"><h2>一句话总结</h2><div class="bigline">'+sum+'</div></div>');

  /* ② 模型状态总览：免费模型 */
  H.push('<div class="card"><h2>免费模型还能用多久<h2 class="q">官方说的截止时间；到期自动标记"已到期"，官方延期了登记表会自动跟着改</h2></h2>');
  if(!d.freeModels.length)H.push('<div class="empty">没有登记的免费模型</div>');
  else{
    H.push('<table><thead><tr><th>模型</th><th>免费到</th><th>还剩多久</th><th>状态</th></tr></thead><tbody>');
    for(const m of d.freeModels){
      const until=String(m.expiry).replace(/T23:59:59\\+08:00/,'').replace(/T00:00:00\\+08:00/,'');
      const cls=m.expired?'err':(m.leftMs<7*864e5?'warn':'ok');
      const isTimeWindow=/23:00/.test(m.freeWindow||'');
      const winHtml=m.freeWindow?(isTimeWindow?'<b style="color:var(--warn)">'+esc(m.freeWindow)+'</b>':esc(m.freeWindow)):'';
      H.push('<tr><td><b>'+esc(mc(m.upstreamModel||m.model))+'</b>'+(winHtml?'<div style="color:var(--text3);font-size:.72rem">'+winHtml+'</div>':'')+'</td><td class="mono">'+esc(until)+'</td><td>'+(m.expired?'—':leftText(m.leftMs))+'</td><td><span class="pill '+cls+'">'+(m.expired?'已到期':'可用')+'</span></td></tr>');
    }
    H.push('</tbody></table>');
  }
  H.push('</div>');

  /* ② 模型状态总览：限流 */
  H.push('<div class="card"><h2>现在有没有被限流<h2 class="q">免费模型用太猛会被官方临时限制；哨兵每 5 分钟探一次，撞了/恢复了都记进时间线</h2></h2>');
  const rs=d.rateState||[];
  if(!rs.length)H.push('<div class="empty">还没有限流监控数据</div>');
  else{
    H.push('<table><thead><tr><th>模型</th><th>状态</th><th>预计恢复</th></tr></thead><tbody>');
    for(const r of rs){
      const cls=r.status==='rate-limited'?'err':'ok';
      H.push('<tr><td><b>'+esc(mc(r.model||r.group))+'</b></td><td><span class="pill '+cls+'">'+esc(r.statusText)+'</span></td><td class="ev">'+esc(r.resetText||'官方时间待确认')+'</td></tr>');
    }
    H.push('</tbody></table>');
  }
  H.push('</div>');

  /* ③ 状态变更时间线 */
  H.push('<div class="card"><h2>状态变更时间线<h2 class="q">模型上下架、限流/恢复、到期/延期、官方改日期——都记在这里</h2></h2>');
  const ns=d.events||[];
  if(!ns.length)H.push('<div class="empty">还没有记录</div>');
  else{
    const kinds={'model-added':'模型上架','model-removed':'模型下架','rate-limited':'被限流','rate-recovered':'限流恢复','model-expired':'免费到期','expiry-extended':'到期推迟','expiry-notice':'到期预告','promo-update':'官方日期更新','credits-low':'积分低水位'};
    H.push('<table><thead><tr><th>时间</th><th>事件</th></tr></thead><tbody>');
    for(const n of ns){
      const cls=(n.type==='rate-limited'||n.type==='model-expired'||n.type==='credits-low')?'err':(n.type==='model-added'||n.type==='rate-recovered'||n.type==='expiry-extended')?'ok':'';
      H.push('<tr><td class="mono" style="white-space:nowrap">'+fmtT(n.ts)+'</td><td><span class="pill '+(cls?'':'')+' '+cls+'">'+esc(kinds[n.type]||n.type)+'</span><div class="ev" style="margin-top:.3rem">'+esc(evText(n))+'</div></td></tr>');
    }
    H.push('</tbody></table>');
    H.push('<div class="note">想让这些事件同时推到别处（比如你自己的飞书机器人）？在项目根目录放一个 hooks.json：{"url":"https://…"}，每条事件都会 POST 过去。不配就只记在这里，安静。</div>');
  }
  H.push('</div>');

  /* ④ 模块心跳 */
  H.push('<div class="card"><h2>模块心跳<h2 class="q">盯模型状态的几个后台模块，哪个停了这里直接显示</h2></h2>');
  H.push('<table><thead><tr><th>模块</th><th>干的活</th><th>状态</th><th>最近在忙</th></tr></thead><tbody>');
  const jobs={'wb-shim':'模型目录+调用网关（主页那些模型就是它供的）','free-expiry':'到期哨兵：到期/预告记时间线并标状态','rate-guard':'限流哨兵：限流/恢复记时间线并标状态','promo-sync':'盯官方日期：官方改了免费期自动改登记表'};
  for(const s of d.health||[]){
    H.push('<tr><td class="mono">'+esc(s.name)+'</td><td class="ev">'+esc(jobs[s.name]||'')+'</td><td><span class="pill '+(s.alive?'ok':'err')+'">'+(s.alive?'在岗':'停了')+'</span></td><td class="ev">'+esc(s.lastLogText)+'</td></tr>');
  }
  H.push('</tbody></table></div>');
  document.getElementById('content').innerHTML=H.join('');
}
load();setInterval(load,60000);
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  // 路由匹配一律剥掉 query string（?debug=1 这类参数不能挡住路径匹配）
  const urlPath = (req.url || '/').split('?')[0];
  // /healthz：免鉴权探活
  if (req.method === 'GET' && (urlPath === '/healthz' || urlPath === '/healthz/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, variants: live.map((r) => ({ id: r.variant.id, visible: r.catalog.isVisible(), models: r.catalog.current().length })) }));
    return;
  }
  // /alerts：免鉴权只读——限免到期/积分低水位/新白嫖上线，供监控脚本与人工巡检
  if (req.method === 'GET' && (urlPath === '/alerts' || urlPath === '/alerts/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      variants: live.map((r) => ({
        id: r.variant.id,
        credits: r.credits?.unlimited ? 'unlimited' : (r.credits?.total ?? null),
        // [2026-10-15 dsh] 官方周期用量（按包 CycleCapacityUsed 求和）：free-expiry 烧速/摘要用官方口径
        usage: r.credits?.unlimited ? 'unlimited' : {
          used: (r.credits?.accounts ?? []).reduce((s, a) => s + (a.cycleUsed || 0), 0),
          accounts: (r.credits?.accounts ?? []).map((a) => ({ name: a.packageName, used: a.cycleUsed || 0, remain: a.remain, size: a.size })),
          history: (r.usageHistory ?? []).slice(-288), // 最近 24h 官方用量时间线（2min 粒度）
        },
        freeModels: (r.freeIds ?? []),
        alerts: (r.alerts ?? []).slice(-20),
      })),
      recentEvents: readEvents(30), // 状态变更时间线最近 30 条（events.mjs）
    }, null, 2));
    return;
  }
  // [2026-10-15 dsh] /usage-detail：官方按请求明细（get-user-request-usage）拉全天并按模型聚合。
  // 🔴 缓存（老大钦定）：当天数据只增不变，60s TTL 内直接回缓存；历史日期当天不会再变，缓存到进程生命周期。
  // 今天的数据另加 5s 静默窗（防止连续刷新打官方 API）。
  // 这是官方真账的"谁在烧"，烧速告警/摘要直接引用。query: ?date=YYYY-MM-DD（默认今天）
  if (req.method === 'GET' && (urlPath === '/usage-detail' || urlPath === '/usage-detail/')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : null;
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const day = date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      // 缓存三级：内存 → 磁盘（logs/usage-cache/YYYY-MM-DD.json，历史日期不变=永久有效）→ 官方 API。
    // 历史日期命中磁盘直接回（秒开）；只有"今天"且超过 60s 才重新打官方。
    const cacheKey = day;
    const isToday = cacheKey === todayStr();
    const memHit = usageCache.get(cacheKey);
    if (memHit && (!isToday || Date.now() - memHit.at < 60000)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(memHit.data));
      return;
    }
    if (!memHit) {
      try {
        const diskPath = join(HERE, 'logs', 'usage-cache', `${cacheKey}.json`);
        if (existsSync(diskPath)) {
          const diskData = JSON.parse(readFileSync(diskPath, 'utf8'));
          usageCache.set(cacheKey, { at: Date.now(), data: diskData });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(diskData));
          return;
        }
      } catch { /* 磁盘缓存坏了就走官方 */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
      const payload = await getUsageDayCached(day);
      res.end(JSON.stringify(payload, null, 2));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) })); }
    return;
  }
  // /api/router：二级页面的数据接口（免鉴权只读）
  // 汇总三块：① 免费模型与到期 ② 下次自动动作预告 ③ 飞书通知历史 + 服务健康
  if (req.method === 'GET' && (urlPath === '/api/router' || urlPath === '/api/router/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildRouterData(), null, 2));
    return;
  }
  // [2026-10-15 dsh] /usage：官方积分明细页——按模型聚合的官方真账，日期可选
  if (req.method === 'GET' && (urlPath === '/usage' || urlPath === '/usage/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderUsagePage());
    return;
  }  // /router：二级页面「模型动态」——模型状态总览 / 状态变更时间线 / 模块心跳
  if (req.method === 'GET' && (urlPath === '/router' || urlPath === '/router/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderRouterPage());
    return;
  }
  // 看板：免鉴权只读，不含任何令牌。设计抄 models.dev（sst/models.dev，MIT）：设计token、
  // sticky大写表头、两行单元格、data-sort 列排序、悬停复制、亮暗双主题
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/status' || urlPath === '/status/')) {
    // 积分分包按套餐名聚合：51包里九成零余量，聚合成一行避免糊屏
    const acctRows = (c) => {
      const groups = new Map();
      for (const a of c.accounts ?? []) {
        const g = groups.get(a.packageName) || { name: a.packageName, remain: 0, size: 0, zero: 0, unlimited: a.unlimited === true };
        if (a.unlimited) { g.unlimited = true; g.remain = Infinity; }
        else {
          g.remain += a.remain;
          if (a.remain > 0) g.size += a.size; else g.zero += 1;
        }
        groups.set(a.packageName, g);
      }
      const rows = [...groups.values()].map((g) => {
        const zeroNote = g.zero ? `<span class="subtle">${g.zero} 个已用完</span>` : '';
        const remain = g.unlimited ? '不限' : g.remain.toLocaleString();
        const total = g.unlimited ? '' : ` / ${(g.size + (g.remain > 0 ? 0 : 0)).toLocaleString()}`;
        const pct = g.unlimited ? 100 : Math.min(100, Math.round((g.remain / (g.size || 1)) * 100));
        const bar = g.unlimited ? '' : `<div class="bar"><i style="width:${pct}%"></i></div>`;
        return `<tr><td>${esc(g.name)}${zeroNote}</td><td data-sort="${g.unlimited ? 9e9 : g.remain}" class="num ${g.unlimited || g.remain > 0 ? 'pos' : 'used'}">${remain}${total}</td><td>${bar}</td></tr>`;
      });
      return rows.join('\n') || '<tr><td colspan="3" class="tertiary">无分包明细</td></tr>';
    };
    // 状态徽章数据（2026-10-15 瘦身版）：限流中 / 免费已到期——主页模型信息准确及时
    const rgState = readJsonSafe(join(WB_DIR, '.rate-guard-state.json'), {});
    const limitedByModel = new Map();
    for (const [g, st] of Object.entries(rgState)) {
      if (st?.status === 'rate-limited') limitedByModel.set(st.model ?? GROUP_MODEL[g] ?? g, st);
    }
    const expiryCfg = readJsonSafe(join(WB_DIR, 'free-expiry.json'), { entries: [] });
    const expiredModels = new Set(
      (expiryCfg.entries ?? []).filter((e) => e.expiry && new Date(e.expiry).getTime() <= Date.now()).map((e) => e.model)
    );
    const credCards = live.map((rt) => {
      const c = rt.credits;
      const body = c
        ? `<div class="big">${c.unlimited ? '不限量' : esc((c.total ?? 0).toLocaleString?.() ?? c.total)}</div>
           <div class="subtle">剩余积分 · 周期重置 ${esc(fmtTime(c.cycleResetTime ? Date.parse(c.cycleResetTime) : undefined))}</div>
           <table class="kv"><tbody>${acctRows(c)}</tbody></table>`
        : `<div class="tertiary">${esc(rt.creditsError ?? '尚未抓取')}</div>`;
      return `<div class="card"><h2>${esc(rt.variant.displayName)} <span class="pill ${rt.catalog.isVisible() ? 'on' : ''}">${rt.catalog.isVisible() ? '已登录' : '未登录'}</span></h2>${body}<div class="subtle">积分更新于 ${esc(fmtTime(rt.creditsAtMs))}</div></div>`;
    }).join('\n');
    const modelRow = (m, probe, extId, badge = '') => {
      const efforts = probe ?? (m.reasoning?.supportedEfforts?.length ? m.reasoning.supportedEfforts.join('/') : (m.reasoning?.supports ? '默认档' : '—'));
      const free = m.billing?.free === true;
      const rateTxt = free ? '免费' : (m.billing?.credits ?? '—');
      const fmtK = (n) => n >= 10000 ? `${Math.round(n / 1000)}K` : String(n);
      // 主显示=生效窗口（已开"用最大窗口"）；上游声明多档时小字列出全部可选档
      const cw = m.contextWindow ? fmtK(m.contextWindow) : '—';
      const opts = m.supportedContextWindows?.length > 1 ? `<span class="subtle mono">可选 ${m.supportedContextWindows.map(fmtK).join(' / ')}</span>` : '';
      return `<tr data-search="${esc(`${m.name} ${extId} ${m.billing?.credits ?? ''} ${efforts}`)}">
<td data-sort="${esc(m.name)}"><span class="primary-link">${esc(m.name)}</span>${free ? '<span class="rate free">· 免费</span>' : `<span class="rate mono">· ${esc(rateTxt)}</span>`}${badge}<span class="subtle mono">${esc(extId)}</span></td>
<td data-sort="${m.contextWindow ?? 0}" class="mono num">${cw}${opts}</td>
<td data-sort="${m.supportsImages ? 'a' : 'b'}">${m.supportsImages ? '<span class="pill on">图+文</span>' : '<span class="pill">仅文</span>'}</td>
<td data-sort="${esc(efforts)}">${esc(efforts)}</td>
<td class="copy-cell"><code class="copy-source">${esc(extId)}</code><button class="copy-button" data-copy="${esc(extId)}" aria-label="复制模型 id">⧉</button></td>
</tr>`;
    };
    // 家族分组（组内排序不打乱分组）：覆盖国内+国际两版全部家族
    const FAMILY_DEFS = [
      ['hy', '混元', '腾讯'],
      ['glm', 'GLM', '智谱'],
      ['deepseek', 'DeepSeek', ''],
      ['kimi', 'Kimi', '月之暗面'],
      ['minimax', 'MiniMax', ''],
      ['gpt', 'GPT', 'OpenAI'],
      ['grok', 'Grok', 'xAI'],
      ['gemini', 'Gemini', 'Google'],
      ['claude', 'Claude', 'Anthropic'],
      ['other', '其他', ''],
    ];
    const familyOf = (id) => {
      const s = id.toLowerCase();
      if (s.startsWith('hy')) return 'hy';
      if (s.startsWith('glm')) return 'glm';
      if (s.startsWith('deepseek')) return 'deepseek';
      if (s.startsWith('kimi')) return 'kimi';
      if (s.startsWith('minimax')) return 'minimax';
      if (s.startsWith('gpt')) return 'gpt';
      if (s.startsWith('grok')) return 'grok';
      if (s.startsWith('gemini')) return 'gemini';
      if (s.startsWith('claude')) return 'claude';
      return 'other';
    };
    // 两个大区：国内版 WorkBuddy 在前，国际版 WorkBuddy AI 在后；各自一张表
    // 国际版对外 id 一律加 -intl 后缀（id 即路由：裸名=国内，-intl=国际）
    const externalId = (rt, id) => rt.variant.id === CN_VARIANT.id ? id : `${id}-intl`;
    const sections = [...live]
      .filter((rt) => rt.catalog.isVisible())
      .sort((a, b) => (a.variant.id === CN_VARIANT.id ? -1 : 1) - (b.variant.id === CN_VARIANT.id ? -1 : 1))
      .map((rt) => {
        const models = rt.catalog.current();
        const families = FAMILY_DEFS
          .map(([k, label, vendor]) => ({ k, label, vendor, items: models.filter((m) => familyOf(m.id) === k) }))
          .filter((f) => f.items.length)
          .map(({ k, label, vendor, items }) => `<tbody data-family="${k}">
<tr class="group"><td colspan="5">${esc(label)}${vendor ? ` <span class="subtle" style="display:inline">· ${esc(vendor)}</span>` : ''}<span class="count">${items.length} 个</span></td></tr>
${items.map((m) => {
  const extId = externalId(rt, m.id);
  const isLimited = limitedByModel.get(m.id) || limitedByModel.get(extId);
  const badge = isLimited
    ? '<span class="pill" style="color:var(--err);border-color:var(--err);margin-left:.4rem">限流中</span>'
    : (expiredModels.has(m.id) || expiredModels.has(extId))
      ? '<span class="pill" style="color:var(--warn);border-color:var(--warn);margin-left:.4rem">免费已到期</span>'
      : '';
  return modelRow(m, probeEffortsFor(m.id, rt.lastIdentity), extId, badge);
}).join('\n')}
</tbody>`)
          .join('\n');
        return { rt, models, families };
      });
    const sectionsHtml = sections.map(({ rt, models, families }) => `
<div class="famhead"><h2>${esc(rt.variant.displayName)} <span class="pill on">${rt.variant.id === CN_VARIANT.id ? '国内版' : '国际版'}</span></h2><div class="subtle">${models.length} 个模型 · 剩余积分 ${rt.credits?.unlimited ? '不限' : (rt.credits?.total ?? '—').toLocaleString?.() ?? rt.credits?.total ?? '—'} · 调用 id ${rt.variant.id === CN_VARIANT.id ? '直接用真名' : '真名 + <code>-intl</code> 后缀'}</div></div>
<div class="card" style="padding:0;overflow:auto;margin-bottom:1.25rem">
<table class="models" data-enhanced-table>
<thead><tr>
<th class="sortable">模型（含抵扣系数）</th>
<th class="sortable">上下文</th>
<th class="sortable">输入</th>
<th class="sortable">推理档位</th>
<th>调用 id</th>
</tr></thead>
${families || `<tbody><tr><td colspan="5" class="empty">目录为空：该版未登录或尚未抓到</td></tr></tbody>`}
</table></div>`).join('\n') || '<div class="card empty">目录为空：WorkBuddy 未登录或尚未抓到</div>';
    const acct = live[0]?.accountInfo;
    const totalCredits = live[0]?.credits && !live[0].credits.unlimited ? (live[0].credits.total ?? 0).toLocaleString() : null;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wb-shim · WorkBuddy 模型网关</title><style>
/* 设计 token 抄自 sst/models.dev (MIT) */
:root{--brand:#FD9527;--bg:#FFF;--border:#DDD;--surface:#F5F5F5;--alpha:rgba(255,255,255,.84);--text:#333;--invert:#FFF;--text2:#666;--text3:#999;--ok:#0f7b46;--warn:#9a5b00;--font-mono:'IBM Plex Mono',ui-monospace,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#1E1E1E;--border:#333;--surface:#111;--alpha:rgba(30,30,30,.84);--text:#FFF;--invert:#333;--text2:#AAA;--text3:#666}}
*{margin:0;padding:0;box-sizing:border-box}
html,body{min-height:100%;font-family:Rubik,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;line-height:1.6;color:var(--text);background:var(--bg)}
header{display:flex;gap:.5rem;justify-content:space-between;align-items:center;height:56px;padding:0 1rem;position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid transparent}
.brand{font-weight:600}.brand b{color:var(--brand)}
.navbtn{display:inline-block;padding:.12rem .5rem;border:1px solid var(--brand);border-radius:99px;color:var(--brand);text-decoration:none;font-size:.74rem;font-weight:500;vertical-align:middle}
.navbtn:hover{background:var(--brand);color:var(--invert)}
.wrap{max-width:1200px;margin:0 auto;padding:1.25rem 1.5rem 4rem}
.cols{display:grid;grid-template-columns:minmax(280px,1fr) 2.2fr;gap:1rem;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.card{background:var(--bg);border:1px solid var(--border);border-radius:.6rem;padding:1rem 1.1rem;margin-bottom:1rem}
.card h2{font-size:.95rem;margin:0 0 .75rem;display:flex;align-items:center;gap:.5rem}
.pill{display:inline-block;padding:.1rem .6rem;border-radius:20px;border:1px solid var(--border);font-size:.72rem;font-weight:400;color:var(--text2)}
.pill.on{background:var(--brand);border-color:var(--brand);color:var(--invert)}
.big{font-size:2rem;font-weight:700;color:var(--ok)}
.subtle{display:block;color:var(--text3);font-size:.75rem;margin-top:.125rem}
table{border-collapse:separate;border-spacing:0;font-size:.875rem;width:100%}
.kv td{padding:.35rem .4rem;border-bottom:1px solid var(--border)}
.kv td:first-child{color:var(--text)}
.kv td:nth-child(2){text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.models thead th{position:sticky;top:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);font-size:.72rem;font-weight:400;text-transform:uppercase;letter-spacing:.02em;color:var(--text2);backdrop-filter:blur(6px);background:var(--alpha);z-index:10;cursor:pointer;user-select:none;padding:.75rem}
/* 族头：sticky 在表头正下方（表头高约41px），滚动时列头+族头双层悬浮不遮行 */
.models tr.group td{position:sticky;top:41px;z-index:9}
.models th,.models td{padding:.75rem;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap;height:48px;vertical-align:middle}
.models tbody td{color:var(--text2)}
.models tbody td:first-child,.models tbody td:nth-child(2),.models tbody td:nth-child(3){color:var(--text)}
.models tbody tr:hover td{background:var(--surface)}
.models tbody tr:last-child td{border-bottom:0}
.models tbody tr.hide{display:none}
.sort-indicator{display:inline-block;width:1rem;text-align:center}
.mono{font-family:var(--font-mono);font-size:.8rem}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--ok);font-weight:600}.used{color:var(--text3)}
.bar{height:4px;background:var(--surface);border-radius:2px;min-width:64px;border:1px solid var(--border)}
.bar i{display:block;height:100%;border-radius:2px;background:var(--brand)}
.primary-link{font-weight:500}
.rate{font-size:.78rem;margin-left:.35rem}
.rate.free{color:var(--ok);font-weight:600}
.rate.mono{color:var(--warn)}
tr.group td{background:var(--surface);font-weight:600;font-size:.82rem;color:var(--text);height:36px;padding:.4rem .75rem}
tr.group .count{float:right;color:var(--text3);font-weight:400;font-size:.72rem}
tr.group.hide{display:none}
.famhead{margin:.25rem 0 .5rem}
.famhead h2{font-size:1rem;display:flex;align-items:center;gap:.5rem}
.toolbar{display:flex;gap:.6rem;align-items:center;margin-bottom:.6rem}
#q{padding:.5rem .8rem;border:1px solid var(--border);border-radius:.5rem;font-size:.85rem;background:var(--bg);color:var(--text);width:min(320px,90vw)}
.copy-cell{white-space:nowrap}
.copy-cell code{background:var(--surface);padding:.15rem .45rem;border-radius:.3rem;user-select:all}
.copy-button{background:none;border:none;cursor:pointer;padding:.2rem .35rem;margin-left:.2rem;border-radius:.25rem;color:var(--text3);opacity:.35;transition:opacity .2s}
td:hover .copy-button{opacity:1}
.copy-button:hover{color:var(--text);background:var(--surface)}
.copy-button.ok{color:var(--brand);opacity:1}
.copy-button.ok{color:var(--brand);opacity:1}
.empty{padding:2rem;text-align:center;color:var(--text3)}
footer{color:var(--text3);font-size:.75rem;margin-top:1.25rem}
.connline{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:.15rem 0}
</style></head><body>
<header><div class="brand"><b>wb-shim</b> · WorkBuddy 模型网关${totalCredits ? ` · <span class="pill on">剩余 ${totalCredits} 积分</span>` : ''} · <a class="navbtn" href="/router">⚙ 模型动态</a></div>
<div class="subtle">${esc(acct ? `账号 ${acct.nickname || acct.uid}` : '已登录')} · 数据每 60 秒自动刷新</div></header>
<div class="wrap">
<div class="cols">
<div>
${credCards}<div class="card" id="burnCard"><h2>今日消耗（官方账） <a href="/usage" style="font-size:.75rem;margin-left:.5rem">明细 →</a></h2><div class="tertiary" id="burnBody">加载中…</div></div>
<div class="card"><h2>连接方式</h2>
<div class="connline">地址 <code class="copy-source">http://100.108.133.82:18796/v1</code><button class="copy-button" data-copy="http://100.108.133.82:18796/v1">⧉</button></div>
<div class="connline">API Key <span class="subtle" style="display:inline">在服务端 token.txt 文件里</span></div>
<div class="connline">本机直连把地址换成 <code>127.0.0.1:18796/v1</code></div>
<div class="connline">协议 <code>/v1/chat/completions</code> · <code>/v1/messages</code> · <code>/v1/responses</code></div>
</div>
</div>
<div>
<div class="toolbar"><input id="q" type="search" placeholder="筛选模型…（名称 / id / 倍率）" autocomplete="off"><span class="subtle" id="qcount"></span></div>
${sectionsHtml}
</div>
</div>
<footer>wb-shim 只读看板 · 设计致敬 models.dev · 上游为 WorkBuddy 客户端私有接口，账号与积分风险自担</footer>
</div>
<script>
// 行为抄自 sst/models.dev index.ts（MIT）：data-sort 点列排序（组内） + 行筛选（隐藏空组） + 复制按钮
(function(){
const tables=document.querySelectorAll('table[data-enhanced-table]');
function cellVal(row,i){const c=row.cells[i];return c?.getAttribute('data-sort')??c?.textContent?.trim()??''}
function cmp(a,b,t){if(a===''&&b==='')return 0;if(a==='')return 1;if(b==='')return -1;if(t==='number')return Number(a)-Number(b);return a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'})}
for(const table of tables){
  table.querySelectorAll('th.sortable').forEach((h,col)=>{
    h.insertAdjacentHTML('beforeend','<span class="sort-indicator"></span>');
    h.addEventListener('click',()=>{
      const cur=h.getAttribute('aria-sort');
      const dir=cur==='ascending'?'desc':'asc';
      // 每个 family tbody 内部各自排序，分组不散
      for(const tbody of table.tBodies){
        if(tbody.querySelector('tr.group'))continue;
        const rows=[...tbody.rows];
        rows.sort((ra,rb)=>{const c=cmp(cellVal(ra,col),cellVal(rb,col),h.dataset.type);return dir==='asc'?c:-c});
        rows.forEach(r=>tbody.appendChild(r));
      }
      table.querySelectorAll('th.sortable').forEach(x=>{x.removeAttribute('aria-sort');const i=x.querySelector('.sort-indicator');if(i)i.textContent=''});
      h.setAttribute('aria-sort',dir==='asc'?'ascending':'descending');
      h.querySelector('.sort-indicator').textContent=dir==='asc'?'↑':'↓';
    });
  });
}
const q=document.getElementById('q');
const qc=document.getElementById('qcount');
if(q)q.addEventListener('input',()=>{
  const v=q.value.trim().toLowerCase();
  let shown=0;
  for(const table of tables){
    for(const tbody of table.tBodies){
      let vis=0;
      for(const tr of tbody.rows){
        if(tr.classList.contains('group'))continue;
        const hay=(tr.getAttribute('data-search')||tr.textContent).toLowerCase();
        const hit=!v||hay.includes(v);
        tr.classList.toggle('hide',!hit);
        if(hit)vis++;
      }
      const gh=tbody.querySelector('tr.group');
      if(gh)gh.classList.toggle('hide',vis===0);
      shown+=vis;
    }
  }
  if(qc)qc.textContent=v?(shown+' 个匹配'):'';
});
document.querySelectorAll('.copy-button').forEach(b=>b.addEventListener('click',async()=>{
  const v=b.dataset.copy;
  try{await navigator.clipboard.writeText(v)}catch{const t=document.createElement('textarea');t.value=v;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()}
  b.classList.add('ok');b.textContent='✓';setTimeout(()=>{b.classList.remove('ok');b.textContent='⧉'},1200);
}));
})();
// [2026-10-15 dsh] 今日消耗卡（官方账）：与主刷新同步 60s
function _esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[ch]})}
async function loadBurn(){
  const el=document.getElementById('burnBody'); if(!el) return;
  try{
    const j=await(await fetch('/usage-detail',{cache:'no-store'})).json();
    if(!j.ok) throw new Error(j.error||'unknown');
    const rows=[];
    for(const v of j.variants){
      rows.push('<b>'+_esc(v.id)+'</b>：<span class="mono">'+v.total+'</span> 分 / '+v.requests+' 次');
      const top=(v.models||[]).filter(m=>m.credit>0).slice(0,3);
      for(const m of top){ rows.push('<div class="subtle" style="margin-left:1em">· '+_esc(m.name)+'：'+m.credit.toFixed(2)+' 分（'+m.requests+' 次）</div>'); }
    }
    el.innerHTML=rows.join('');
  }catch(e){ el.textContent='官方账加载失败'; }
}
loadBurn(); setInterval(loadBurn,60000);
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // ?debug=1：把关键元素坐标写进 <title>，供 CDP Runtime.evaluate 诊断排版
    if (new URL(req.url, 'http://x').searchParams.get('debug')) {
      const probe = [
        '<script>',
        "window.addEventListener('load',function(){setTimeout(function(){",
        'var pick=function(el){var r=el.getBoundingClientRect();var s=getComputedStyle(el);return {tag:el.tagName,cls:String(el.className).slice(0,30),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),bg:s.backgroundColor,disp:s.display}};',
        'var out=[];',
        'document.querySelectorAll(".card").forEach(function(c,i){out.push({card:i,...pick(c)})});',
        'document.querySelectorAll("thead").forEach(function(t){out.push({thead:1,...pick(t)})});',
        'document.querySelectorAll("tr.group").forEach(function(g,i){out.push({group:i,text:g.textContent.trim().slice(0,12),...pick(g)})});',
        'document.querySelectorAll(".famhead").forEach(function(f){out.push({famhead:1,...pick(f)})});',
        "document.title='DBG '+JSON.stringify(out);",
        '},400)});',
        '</script>',
      ].join('\n');
      res.end(html.replace('</body>', probe + '</body>'));
      return;
    }
    res.end(html);
    return;
  }
  // 其余路由：Bearer TOKEN
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'unauthorized', code: 'unauthorized' } }));
    return;
  }
  // /v1/models：带倍率/上下文/视觉/推理明细（OpenAI 扩展字段，标准客户端自动忽略）
  // 国际版对外 id 加 -intl 后缀（id 即路由，与 chat 路由规则一致）
  if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/v1/models/')) {
    const data = live.flatMap((rt) => {
      const isCn = rt.variant.id === CN_VARIANT.id;
      return rt.catalog.current().map((m) => {
        const extId = isCn ? m.id : `${m.id}-intl`;
        const probe = probeEffortsFor(m.id, rt.lastIdentity);
        return {
          id: extId,
          object: 'model',
          created: 0,
          owned_by: `workbuddy/${rt.variant.id}`,
          name: m.name,
          context_window: m.contextWindow,
          max_input_tokens: m.maxInputTokens,
          supports_images: m.supportsImages === true,
          credits_rate: m.billing?.credits,
          free: m.billing?.free === true,
          badges: m.billing?.badges ?? [],
          efforts: probe ?? m.reasoning?.supportedEfforts ?? undefined,
          reasoning: m.reasoning?.supports === true,
        };
      });
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
    return;
  }
  // /v1/credits：各变体积分
  if (req.method === 'GET' && (urlPath === '/v1/credits' || urlPath === '/v1/credits/')) {
    const out = {};
    for (const rt of live) {
      out[rt.variant.id] = rt.credits ? {
        total: rt.credits.unlimited ? 'unlimited' : rt.credits.total,
        unlimited: rt.credits.unlimited === true,
        accounts: rt.credits.accounts ?? [],
        cycleResetTime: rt.credits.cycleResetTime,
        fetchedAt: rt.creditsAtMs,
        ...(rt.creditsError ? { error: rt.creditsError } : {}),
      } : { error: rt.creditsError ?? '尚未抓取（等一轮轮询）' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  // [2026-10-15 workbuddy] /v1/credits-summary：官方 summary 接口实时代理（带小数精度）。
  // 桌面端"套餐与积分"页同源口径（总剩余 6738.68 这种小数就是它出的）：
  // POST /billing/meter/get-user-resource-summary，body={}，响应 packages[] 含 cycleRemain/cycleTotal。
  // 与 /v1/credits（get-user-resource 整数口径）并存，互不影响。
  if (req.method === 'GET' && (urlPath === '/v1/credits-summary' || urlPath === '/v1/credits-summary/')) {
    const out = {};
    await Promise.all(live.map(async (r) => {
      try {
        const cred = await r.store.resolve();
        const isIntl = r.variant.id !== CN_VARIANT.id;
        const base = isIntl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
        const headers = { 'Authorization': `Bearer ${cred.accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
        if (cred.uid) headers['X-User-Id'] = cred.uid;
        if (cred.domain) headers['X-Domain'] = cred.domain;
        const resp = await fetch(`${base}/billing/meter/get-user-resource-summary`, {
          method: 'POST', headers, body: JSON.stringify({}),
          signal: AbortSignal.timeout(15000),
        });
        const j = await resp.json().catch(() => null);
        out[r.variant.id] = {
          httpStatus: resp.status,
          code: j?.code,
          data: j?.data ?? null,
          ...(j && j.code !== 0 && j.code !== undefined ? { msg: j.msg } : {}),
          ...(!resp.ok ? { error: `HTTP ${resp.status}` } : {}),
        };
      } catch (e) { out[r.variant.id] = { error: String(e).slice(0, 150) }; }
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }
  // [2026-10-15 workbuddy] /v1/usage-recent?since=<epochMs>&until=<epochMs>：
  // 官方按请求明细（get-user-request-usage）时间窗查询，每条请求自带官方精确 credit。
  // 给 dsh-web 每轮对话消耗显示用（本轮窗口=上一条 assistant 消息到本条）。
  // 同窗口 5s 内存缓存 + 单飞，防连续消息打爆官方。
  if (req.method === 'GET' && (urlPath === '/v1/usage-recent' || urlPath === '/v1/usage-recent/')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const until = Number(u.searchParams.get('until')) || Date.now();
      const since = Number(u.searchParams.get('since')) || until - 5 * 60000;
      const minutes = Math.ceil((until - since) / 60000);
      const key = `${Math.floor(since / 30000)}:${Math.floor(until / 30000)}:${minutes}`; // 30s 桶粒度缓存
      const hit = usageRecentCache.get(key);
      if (hit && Date.now() - hit.at < 5000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hit.data));
        return;
      }
      const inflight = usageRecentInflight.get(key);
      if (inflight) { const d = await inflight; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); return; }
      const p = (async () => {
        const results = await Promise.all(live.map(async (r) => {
          try {
            const cred = await r.store.resolve();
            const isIntl = r.variant.id !== CN_VARIANT.id;
            const base = isIntl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
            const headers = { 'Authorization': `Bearer ${cred.accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
            if (cred.uid) headers['X-User-Id'] = cred.uid;
            if (cred.domain) headers['X-Domain'] = cred.domain;
            const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            const rows = [];
            for (let pageNum = 1; pageNum <= 10; pageNum++) {
              const resp = await fetch(`${base}/billing/meter/get-user-request-usage`, {
                method: 'POST', headers,
                body: JSON.stringify({ startTime: fmt(new Date(since)), endTime: fmt(new Date(until)), pageNum, pageSize: 200 }),
                signal: AbortSignal.timeout(15000),
              });
              const j = await resp.json();
              const list = j?.data?.data;
              if (!Array.isArray(list)) break;
              rows.push(...list);
              if (rows.length >= (j?.data?.total || 0) || list.length < 200) break;
            }
            return { id: r.variant.id, requests: rows.map((x) => ({ ...x, requestId: x.requestId, requestTime: x.requestTime, model: x.model, credit: Number(x.credit) || 0 })) };
          } catch (e) { return { id: r.variant.id, error: String(e).slice(0, 150) }; }
        }));
        return { ok: true, since, until, variants: results };
      })();
      usageRecentInflight.set(key, p);
      let data;
      try { data = await p; } finally { usageRecentInflight.delete(key); }
      usageRecentCache.set(key, { at: Date.now(), data });
      if (usageRecentCache.size > 200) usageRecentCache.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
    }
    return;
  }
  // [2026-10-15 dsh] /v1/credit-log?since=<epochMs>&until=<epochMs>：
  // 即时 credit 明细（上游聊天响应 usage.credit，官方精确值零延迟）。内存环形 + jsonl 回灌，
  // 查询纯本地零外呼——dsh-web 每轮消耗 pill 的即时通道就打这里。
  if (req.method === 'GET' && (urlPath === '/v1/credit-log' || urlPath === '/v1/credit-log/')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const until = Number(u.searchParams.get('until')) || Date.now() + 1;
      const since = Number(u.searchParams.get('since')) || until - 5 * 60000;
      const entries = creditLog.filter((e) => e.t >= since && e.t <= until);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, since, until, entries }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
    }
    return;
  }
  // /v1/chat/completions：按模型路由到对应 variant 的插件 shim（它做上游协议怪癖）。
  // 上游强制流式；非流式请求在这里把 SSE 聚合成标准 chat.completion JSON 返回，
  // 否则 litellm 等非流式客户端会拿 SSE 文本当 JSON 解析炸掉（openai.py:449）。
  if (req.method === 'POST' && (urlPath === '/v1/chat/completions' || urlPath === '/v1/chat/completions/')) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 67108864) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      let bodyObj = {};
      try { bodyObj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const modelId = bodyObj.model || '';
      const wantStream = bodyObj.stream === true;
      // 整段包 try：路由解析/转发构造一旦抛异常（历史上有过 header 值 undefined
      // 炸进程），回 502 让客户端走重试，绝不让请求挂死等超时。
      try {
      // 路由规则：id 即路由。
      //   裸名（hy3 / deepseek-v4.1-flash）          → 国内版（workbuddy）
      //   -intl 后缀（hy3-intl / deepseek-…-intl）   → 国际版（workbuddy-ai），剥掉后缀再发上游
      //   兜底：裸名在国内版没有时也试国际版（两版 id 不重叠的模型，如 gpt-6-astra，无需后缀也能通）
      const INTL_SUFFIX = '-intl';
      const isIntl = modelId.toLowerCase().endsWith(INTL_SUFFIX);
      const upstreamId = isIntl ? modelId.slice(0, -INTL_SUFFIX.length) : modelId;
      const want = isIntl ? 'workbuddy-ai' : 'workbuddy';
      let rt = live.find((r) => r.variant.id === want && r.catalog.current().some((m) => m.id === upstreamId));
      // 兜底：指定版没有该模型时试另一版（仍按裸名匹配），避免"国际版独有模型忘了加 -intl"被 404
      if (!rt) rt = live.find((r) => r.catalog.current().some((m) => m.id === upstreamId));
      if (!rt) rt = live.find((r) => fallbackFor(r.variant).some((m) => m.id === upstreamId));
      if (!rt) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no workbuddy model: ${modelId}`, type: 'not_found', code: 'not_found' } }));
        return;
      }
      // 发给插件 shim 的 body 用剥后缀后的真名
      const upstreamBody = { ...bodyObj, model: upstreamId };
      const upstreamBuf = Buffer.from(JSON.stringify(upstreamBody));
      const target = rt._pluginShim;
      const u = new URL(req.url, target.baseUrl());
      // 超时/中止控制：硬超时触发后阻断下游再写 res（避免与挂死的 proxyRes 流冲突）
      const ctrl = { aborted: false };
      let proxyResRef = null;
      const proxyReq = http.request(u, {
        method: 'POST',
        headers: {
          // 只带白名单头：原始 Content-Length 对应改写前的 body，透传会让插件 shim 等不齐字节挂死
          'content-type': req.headers['content-type'] || 'application/json',
          'content-length': upstreamBuf.length,
          accept: req.headers.accept || '*/*',
          host: u.host,
          authorization: `Bearer ${target.token()}`,
        },
      });
      // 🔴 上游无响应兜底：若 shim 在时限内完全不返回（真·挂死），主动掐断并向上游
      // 调用方返 429（限流语义，而非 504），让调用方正确退避而非狂重试。
      // 注：限流时上游实际会返 429，真正让它挂死的是响应体管道笔误（已修 proxyRes.pipe(res)）；
      // 此兜底仅针对「完全无响应」场景，避免真实用户/探针被卡 200s+。
      proxyReq.setTimeout(Number(process.env.WB_SHIM_UPSTREAM_TIMEOUT_MS || 60000), () => {
        console.error(`[wb-shim] 上游超时(${process.env.WB_SHIM_UPSTREAM_TIMEOUT_MS || 60000}ms): ${upstreamId} ⇒ 返 429（疑似限流）`);
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '3600' });
          res.end(JSON.stringify({ error: { message: 'upstream timeout：workbuddy 上游未在时限内响应，疑似限流中（无官方重置时间，哨兵每轮复探）', type: 'rate_limit_timeout', code: 'rate_limit_timeout' } }));
        } else res.end();
      });
      proxyReq.on('response', (proxyRes) => {
        // 已拿到响应：取消请求级超时，避免慢速 SSE 流被误掐（剩下交给读取侧）
        proxyReq.setTimeout(0);
        proxyResRef = proxyRes;
        const status = proxyRes.statusCode || 502;
        const isSse = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
        if (status !== 200 || !isSse || wantStream) {
          // 429 限流记账（烧速/拥堵判断的依据）
          if (status === 429) recordLimit(upstreamId, null);
          res.writeHead(status, proxyRes.headers);
          // 流式分支：旁路统计 usage（直通不改数据，只数最后 chunk 的 usage）
          if (wantStream && isSse && status === 200) {
            let tail = '';
            proxyRes.on('data', (chunk) => {
              // [2026-10-15 dsh] 加大到 3000 字符：usage 收尾 chunk 常常不在最后一个网络包里
              tail = (tail + String(chunk)).slice(-3000);
            });
            proxyRes.on('end', () => {
              const m = tail.match(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)[^}]*\}/);
              const pm = tail.match(/"prompt_tokens"\s*:\s*(\d+)/);
              const cm = tail.match(/"completion_tokens"\s*:\s*(\d+)/);
              if (m) recordUsage(upstreamId, { total_tokens: Number(m[1]) || 0, prompt_tokens: pm ? Number(pm[1]) : 0, completion_tokens: cm ? Number(cm[1]) : 0 });
              // [2026-10-15 dsh] 流式收尾 chunk 的 usage.credit 同样是官方精确值，一并记账
              const crm = tail.match(/"credit"\s*:\s*([0-9.]+)/);
              if (crm) recordCredit(upstreamId, { credit: Number(crm[1]) || 0, prompt_tokens: pm ? Number(pm[1]) : 0, completion_tokens: cm ? Number(cm[1]) : 0 });
            });
          }
          proxyRes.pipe(res);
          return;
        }
        // 聚合 SSE → chat.completion JSON
        let buf = '';
        const toolCalls = [];
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let content = '', reasoning = '', finish = '', id = '', model = '', created = 0;
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', (d) => { buf += d; let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let ev; try { ev = JSON.parse(payload); } catch { continue; }
            const ch = ev.choices?.[0]; if (!ch) continue;
            id = ev.id || id; model = ev.model || model; created = ev.created || created;
            if (ev.usage) Object.assign(usage, ev.usage);
            const delta = ch.delta || {};
            if (typeof delta.content === 'string' && delta.content) content += delta.content;
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) reasoning += delta.reasoning_content;
            for (const tc of delta.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              toolCalls[idx] = toolCalls[idx] || { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
            if (ch.finish_reason) finish = ch.finish_reason;
          }
        });
        proxyRes.on('end', () => {
          if (ctrl.aborted) return;
          const message = { role: 'assistant', content: content || null };
          if (reasoning) message.reasoning_content = reasoning;
          if (toolCalls.length) message.tool_calls = toolCalls;
          if (!usage.total_tokens && usage.completion_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: id || 'wb-agg', object: 'chat.completion', created: created || Math.floor(Date.now() / 1000), model: model || modelId, choices: [{ index: 0, message, finish_reason: finish || 'stop' }], usage }));
          // 🔴 记账（2026-10-14）：每模型 token 用量——烧速告警"谁在烧"就靠这个
          recordUsage(upstreamId, usage);
          // [2026-10-15 dsh] 即时 credit 记账：usage.credit 是官方精确扣分（实测与
          // get-user-request-usage 相等），零延迟，dsh-web 每轮消耗 pill 的即时数据源
          recordCredit(upstreamId, usage);
        });
        proxyRes.on('error', () => {
          if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); }
          res.end(JSON.stringify({ error: { message: 'upstream stream failed', type: 'server', code: 'server' } }));
        });
      });
      proxyReq.on('error', (e) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(e), type: 'server', code: 'server' } }));
        } else res.end();
      });
      proxyReq.end(upstreamBuf);
      // 🔴 全局硬超时：覆盖「上游完全无响应」与「返 200 但 SSE 流不结束」两类挂死，
      // 60s 内强制结束并返 429（限流语义），杜绝真实用户/探针被卡。res 结束即清。
      const hardTimer = setTimeout(() => {
        ctrl.aborted = true;
        console.error(`[wb-shim] 上游硬超时(60s): ${upstreamId} ⇒ 返 429（疑似限流）`);
        try { proxyReq.destroy(); } catch {}
        try { proxyResRef?.destroy(); } catch {}
        if (!res.headersSent) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '3600' });
          res.end(JSON.stringify({ error: { message: 'upstream timeout：workbuddy 上游未在时限内响应，疑似限流中（无官方重置时间，哨兵每轮复探）', type: 'rate_limit_timeout', code: 'rate_limit_timeout' } }));
        }
      }, Number(process.env.WB_SHIM_UPSTREAM_TIMEOUT_MS || 60000));
      res.on('finish', () => clearTimeout(hardTimer));
      res.on('close', () => clearTimeout(hardTimer));
      } catch (e) {
        // 转发构造期炸了（路由/URL/headers）：给客户端一个明确的 502，别挂死
        log('chat 转发构造异常:', e?.stack || String(e));
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `shim proxy setup failed: ${String(e)}`, type: 'server', code: 'server' } }));
        } else res.end();
      }
    });
    return;
  }

  // ── 协议适配路由（2026-10-15 老大令）────────────────────────────────────
  // 上游只讲 OpenAI chat/completions；这里按【路径】给两种协议的客户端做双向转换：
  //   POST /v1/messages  → Anthropic Messages（claude bot）
  //   POST /v1/responses → OpenAI Responses（codex bot）
  // 🔴 按路径分、不按模型分：三条路径共用同一份模型目录，glm-5.3-flash / hy3 /
  //    deepseek-v4-pro 谁都能走任一条，不存在"某模型只能配某条路"。
  // 🔴 一律用非流式发给上游（stream:false）—— 实测本 shim 的 chat 路由传
  //    stream:true 会返回 200 但零字节（上游插件 shim 强制流式又吐不出东西）。
  //    拿到完整 JSON 后再按目标协议合成 SSE，绕开该坑。
  if (req.method === 'POST' && (urlPath === '/v1/messages' || urlPath === '/v1/messages/')) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 67108864) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      (async () => {
        let bodyObj = {};
        try { bodyObj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        const isAnthropic = true;
        try {
          const chatBody = anthropicToChat(bodyObj);
          // 模型路由复用 chat 路由的同一套规则（-intl 后缀 / 兜底跨版本）
          const modelId = chatBody.model || '';
          const INTL_SUFFIX = '-intl';
          const isIntl = modelId.toLowerCase().endsWith(INTL_SUFFIX);
          const upstreamId = isIntl ? modelId.slice(0, -INTL_SUFFIX.length) : modelId;
          const want = isIntl ? 'workbuddy-ai' : 'workbuddy';
          let rt = live.find((r) => r.variant.id === want && r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = live.find((r) => r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = live.find((r) => fallbackFor(r.variant).some((m) => m.id === upstreamId));
          if (!rt) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `no workbuddy model: ${modelId}` } }));
            return;
          }
          const upstreamBody = { ...chatBody, model: upstreamId };
          // 🔴 必须拼 /v1/chat/completions：插件 shim 只认这一个路由（lib/index.js:745）。
          //    baseUrl() 只是根地址，直接 fetch 会变成 POST / → 404 no such route。
          const up = await fetch(new URL('/v1/chat/completions', rt._pluginShim.baseUrl()), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt._pluginShim.token()}` },
            body: JSON.stringify(upstreamBody),
          });
          if (!up.ok) {
            const rawText = await up.text().catch(() => '');
            res.writeHead(up.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: rawText.slice(0, 400) } }));
            return;
          }
          // 上游恒吐 SSE（不看 stream 参数）⇒ 聚合成 chat.completion JSON
          const chat = await aggregateSseToChat(up.body);
          if (bodyObj.stream === true) chatToAnthropicSSE(res, chat, modelId);
          else chatToAnthropicJson(res, chat, modelId);
        } catch (e) {
          log('anthropic 路由异常:', e?.stack || String(e));
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e).slice(0, 200) } }));
          } else res.end();
        }
      })();
    });
    return;
  }

  if (req.method === 'POST' && (urlPath === '/v1/responses' || urlPath === '/v1/responses/')) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 67108864) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      (async () => {
        let bodyObj = {};
        try { bodyObj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        try {
          const chatBody = responsesToChat(bodyObj);
          const modelId = chatBody.model || '';
          const INTL_SUFFIX = '-intl';
          const isIntl = modelId.toLowerCase().endsWith(INTL_SUFFIX);
          const upstreamId = isIntl ? modelId.slice(0, -INTL_SUFFIX.length) : modelId;
          const want = isIntl ? 'workbuddy-ai' : 'workbuddy';
          let rt = live.find((r) => r.variant.id === want && r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = live.find((r) => r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = live.find((r) => fallbackFor(r.variant).some((m) => m.id === upstreamId));
          if (!rt) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `no workbuddy model: ${modelId}`, code: 'not_found' } }));
            return;
          }
          const upstreamBody = { ...chatBody, model: upstreamId };
          // 🔴 必须拼 /v1/chat/completions：插件 shim 只认这一个路由（lib/index.js:745）。
          //    baseUrl() 只是根地址，直接 fetch 会变成 POST / → 404 no such route。
          const up = await fetch(new URL('/v1/chat/completions', rt._pluginShim.baseUrl()), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt._pluginShim.token()}` },
            body: JSON.stringify(upstreamBody),
          });
          if (!up.ok) {
            const rawText = await up.text().catch(() => '');
            res.writeHead(up.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: rawText.slice(0, 400), code: 'upstream_error' } }));
            return;
          }
          // 上游恒吐 SSE（不看 stream 参数）⇒ 聚合成 chat.completion JSON
          const chat = await aggregateSseToChat(up.body);
          if (bodyObj.stream === true) chatToResponsesSSE(res, chat, modelId);
          else chatToResponsesJson(res, chat, modelId);
        } catch (e) {
          log('responses 路由异常:', e?.stack || String(e));
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: String(e).slice(0, 200), code: 'upstream_error' } }));
          } else res.end();
        }
      })();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no such route: ${req.method} ${req.url}`, type: 'not_found', code: 'not_found' } }));
});

server.listen(PORT, HOST, () => {
  log(`wb-shim 就绪: http://${HOST}:${PORT} (Bearer 固定 token，长度 ${TOKEN.length})`);
  log(`挂载 variant: ${live.map((r) => r.variant.id).join(', ')}`);
  // [2026-10-15 dsh] 回灌即时 credit 日志（重启不丢最近的每轮消耗）
  loadCreditLog();
  // [2026-10-15 dsh] 启动后台预取最近 7 天官方账（跳过磁盘已有）——/usage 页翻开即秒开
  setTimeout(() => { prefetchRecentUsage().catch((e) => log('预取失败:', String(e).slice(0, 150))); }, 8000);
});

// 定时目录轮询（登录晚到/切换/模型上架都能跟上）
setInterval(() => { for (const rt of live) sweep(rt).catch((e) => log('sweep 异常:', String(e))); }, REFRESH_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，清理…');
    for (const rt of live) rt._pluginShim?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// 🔴 进程级异常兜底（2026-10-13 加）：请求处理里一个畸形请求（如 header 值为
// undefined）曾把整个进程炸穿，全家 bot 跟着断。这里接住未捕获异常/未处理拒绝，
// 只记日志不退出——单个请求烂掉是它的命，服务必须活着。
// 注意：只兜"请求路径"上的漏网异常；sweep 等后台任务自己有 try/catch。
process.on('uncaughtException', (err) => {
  log('uncaughtException 已兜底（不退出）:', err?.stack || String(err));
});
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection 已兜底（不退出）:', reason?.stack || String(reason));
});
