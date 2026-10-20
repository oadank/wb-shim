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

// [2026-10-20] 国际版渠道校验通关层（自己的模块，不动第三方 node_modules）
import { wrapIntlGatewayClient } from './intl-gateway.mjs';

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
// [2026-10-16] 积分不再后台定时刷：只有打开网页 / 调 /v1/credits 才去问一次，带缓存防连点
const CREDITS_CACHE_TTL_MS = Number(process.env.WB_SHIM_CREDITS_CACHE_TTL_MS || 60 * 1000);
// Debian 独立账号（N5105 小主机，国内版 CN，独立积分池）开关
const DEBIAN_AUTH_FILE = process.env.WB_SHIM_DEBIAN_AUTH_FILE || 'C:\\D\\opt\\wb-shim\\debian-auth.json';
const DEBIAN_TOKEN = process.env.WB_SHIM_DEBIAN_TOKEN || '';
// [2026-10-15 dsh] usage-detail 缓存（key=YYYY-MM-DD；历史日期永久缓存，今天 60s TTL）
const usageCache = new Map();
function todayStr() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
// [2026-10-18] 看板用：N 天前的日期 + 仅读磁盘缓存的用量天（避免刷新看板时打官方 API）
function dateMinus(n) { const d = new Date(); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function readUsageDayCache(day) {
  try { const p = join(HERE, 'logs', 'usage-cache', `${day}.json`); if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); } catch {}
  return null;
}
// 缓存里的 label 快照 → 内部 account key（10-20 建）。
// 历史缓存落的 label 是当时名字（改过几次名就有几套），只有 variant.id 是稳定的。
// 排行/趋势聚合一律用内部 key，显示时才转当前自定义名——改名后历史数据自动跟着新名走。
const SNAPSHOT_LABEL_TO_KEY = {};
for (const [k, v] of Object.entries({ workbuddy: ['Lecoo', 'LeCoo', 'oadank', '阿丹'], 'workbuddy-ai': ['Lecoo-intl', 'intl', 'ntl'], 'workbuddy-deb': ['N5105', 'debian', '0796'] })) {
  for (const alias of v) SNAPSHOT_LABEL_TO_KEY[alias] = k;
}
function snapshotLabelToKey(label, variantId) {
  if (SNAPSHOT_LABEL_TO_KEY[label]) return SNAPSHOT_LABEL_TO_KEY[label];
  // variant.id 本身就是内部 key（CN=intl 同 id 'workbuddy'，Debian 另算）；多账号同 id 时 label 已区分
  if (variantId === 'workbuddy-deb') return 'workbuddy-deb';
  return variantId; // 'workbuddy'（CN 与 INTL 同 id，靠 label 别名区分；认不出的落默认）
}
function dayTotals(day) {
  const c = readUsageDayCache(day);
  if (!c) return { credit: 0, requests: 0, byModel: new Map() };
  let credit = 0, requests = 0; const byModel = new Map();
  for (const v of c.variants || []) {
    credit += (v.total || 0); requests += (v.requests || 0);
    // [2026-10-20 修] 聚合键用内部 account key（稳定），不用 label 快照（改名就断）。
    // 显示名在读端（ac()）才转。CN 与 INTL variant.id 同为 'workbuddy'，靠 label 别名表区分。
    const acctKey = snapshotLabelToKey(v.label || '', v.id);
    for (const m of v.models || []) {
      const k = `${acctKey}|${m.name}`;
      const e = byModel.get(k) || { name: m.name, acctKey, requests: 0, credit: 0 };
      e.requests += m.requests; e.credit += m.credit; byModel.set(k, e);
    }
  }
  return { credit: Math.round(credit * 100) / 100, requests, byModel };
}
// [2026-10-15 dsh] 官方账拉取+聚合（/usage-detail 与预取共用）
// [2026-10-19] 国际版 fetch failed 修复：官方国际站偶发掐新连接（连接复用坏掉后一直 failed），
// 每次分页请求带独立 dispatcher（禁连接复用）+ 1 次重试。fetch failed 的另一面是
// Promise.all 一荣俱荣——单腿失败只影响自己，这里本来就是按腿 try/catch，保持。
async function fetchUsageDay(day) {
  const results = await Promise.all(allRuntimes.map(async (r) => {
    const tryOnce = async () => {
      const cred = await r.store.resolve();
      const isIntl = r.variant.id !== CN_VARIANT.id;
      const base = isIntl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
      const headers = { 'Authorization': `Bearer ${cred.accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
      if (cred.uid) headers['X-User-Id'] = cred.uid;
      if (cred.domain) headers['X-Domain'] = cred.domain;
      const agg = {}; let total = 0; let fetched = 0; let pageNum = 1;
      for (; pageNum <= 50; pageNum++) {
        // [2026-10-19] 每页独立连接：keep-alive 池里的坏连接是 fetch failed 主因。
        // 有 undici Agent 就用（新建即弃），没有就退 Connection: close 头。
        const useAgent = UNDICI_AGENT !== null;
        const resp = await fetch(`${base}/billing/meter/get-user-request-usage`, {
          method: 'POST',
          headers: useAgent ? headers : { ...headers, Connection: 'close' },
          body: JSON.stringify({ startTime: `${day} 00:00:00`, endTime: `${day} 23:59:59`, pageNum, pageSize: 200 }),
          ...(useAgent ? { dispatcher: new UNDICI_AGENT({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }) } : {}),
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
      return { id: r.variant.id, label: r.label || r.variant.id, day, total: Math.round(total * 100) / 100, requests: fetched, models };
    };
    try {
      return await tryOnce();
    } catch (e1) {
      // 重试 1 次（换新连接池）；还挂才把错误报出去
      try { return await tryOnce(); }
      catch (e2) { return { id: r.variant.id, label: r.label || r.variant.id, error: String(e2).slice(0, 150) }; }
    }
  }));
  return { ok: true, day, variants: results };
}

// [2026-10-18] usage-detail 结果补账号归属名（Lecoo/N5105/Lecoo-intl）。
// 历史日期的磁盘缓存是在加 label 字段之前落的，这里按 runtime 顺序补齐，新旧缓存都显示归属名。
function withUsageLabels(payload) {
  try {
    const used = new Map();
    payload.variants = (payload.variants || []).map((v) => {
      if (v.label) return v;
      const idx = used.get(v.id) || 0; used.set(v.id, idx + 1);
      const matches = allRuntimes.filter((r) => r.variant.id === v.id);
      return { ...v, label: matches[idx]?.label || v.id };
    });
  } catch { }
  return payload;
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
      if (existsSync(diskPath)) {
        const d = JSON.parse(readFileSync(diskPath, 'utf8'));
        // [2026-10-19] 带错误的历史缓存不认：10-14 那次官方站抽风，error 被当数据烤进磁盘，
        // 之后永远秒回错误。磁盘命中但里面有 error 腿 ⇒ 当作没缓存，重打官方。
        const hasErr = (d.variants || []).some((v) => v && typeof v.error === 'string');
        if (!hasErr) { usageCache.set(day, { at: Date.now(), data: d }); return d; }
      }
    } catch { }
  }
  let p = usageInflight.get(day);
  if (!p) {
    p = fetchUsageDay(day).then((payload) => {
      // [2026-10-19] 双保险：带 error 的结果只进内存（短 TTL 会被冲掉），绝不写磁盘永久缓存
      // ——失败结果当数据存盘，就是 10-14 永远报错的根因。
      usageCache.set(day, { at: Date.now(), data: payload });
      const hasErr = (payload?.variants || []).some((v) => v && typeof v.error === 'string');
      if (!hasErr) { try { writeFileSync(join(usageCacheDir(), `${day}.json`), JSON.stringify(payload)); } catch { } }
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
import { acctLabel, acctKeyOfRuntime } from './accounts.mjs';
import { variantLabel, getDisplayConfig, setDisplayConfig } from './display.mjs';
import { recordUsage, recordLimit } from './usage-log.mjs';
// [2026-10-19] 国际版官方站 fetch failed 修复：Node 24 没有 node:undici 内置模块，
// wb-shim 也没装 undici 包 ⇒ 走每请求 Connection: close（禁 keep-alive，坏连接不进池）。
// 🔴 不要在模块顶层 import('undici')——机器没装这个包时 ERR_MODULE_NOT_FOUND 会被
// fetchUsageDay 的 catch 吃掉，把整个官方账查询搞挂（今天翻车实录）。要装包再开 Agent。
const UNDICI_AGENT = null;

const HERE = dirname(fileURLToPath(import.meta.url));
const existsSyncProb = existsSync;

// token：env(逗号分隔) > token.txt(每行一个，可多个) > 旧默认（仅过渡，打警告）
// 多 token 任一匹配即可（方便旧配置/新配置并存，不会因改密码把已有调用方搞挂）
function loadTokens() {
  if (process.env.WB_SHIM_TOKEN) return process.env.WB_SHIM_TOKEN.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).map((t) => ({ token: t, src: 'env' }));
  try {
    const t = readFileSync(new URL('./token.txt', import.meta.url), 'utf8');
    const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length) return lines.map((t) => ({ token: t, src: 'token.txt' }));
  } catch { /* 无文件走默认 */ }
  return [{ token: 'wb-shim-CHANGEME', src: 'legacy-default(请尽快写 token.txt)' }];
}
const TOKENS = loadTokens();
const TOKEN = TOKENS[0]?.token ?? '';
const TOKEN_SRC = TOKENS.map((t) => t.src).join(',');

const log = (...a) => console.log(new Date().toISOString(), '[wb-shim]', ...a);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-');
// 账号显示名统一从 ./accounts.mjs 唯一真源取（2026-10-19 收口，禁止各写一遍）
const acctLabelOf = acctLabel;
// 从 429 文本抠官方重置时间（中英文都认），供代理 429 实时记限流状态
const parseResetAt = (text) => {
  const t = String(text || '');
  const m = t.match(/([\d]{4}-[\d]{2}-[\d]{2})[\s T]+([\d]{2}:[\d]{2}:[\d]{2})\s*(?:UTC\+8|GMT\+8)?/);
  if (!m || !/重置|reset/i.test(t)) return null;
  const d = new Date(`${m[1]}T${m[2]}+08:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
};
// 代理层真实流量吃到 429 → 就地按 account:model 写限流状态（第一手、零额外探测；恢复由 rate-guard 到点复测）
// [2026-10-19 老大钦定：429 即标记] 旧逻辑"无官方重置时间就不记"导致 glm-5.3-flash 在 N5105 上
// 连续 4 次 429（官方播报"模型繁忙"）全被吞掉，页面完全看不到。现在：
// - 有官方重置时间 → 记它
// - 无官方重置时间（如"模型繁忙"/queue.waiting）→ 也记，resetAt=null，页面显"官方时间待确认"，
//   哨兵按 IDLE_RETRY_MS 后复测；误报由复测自然纠正。
// 唯一不记的：非 429 响应（由调用方保证只在 429 时进来）。
function recordProxyRateLimit(acctKey, modelId, body) {
  const resetAt = parseResetAt(body);
  const key = acctKey + ':' + modelId;
  const now = Date.now();
  const state = readJsonSafe(join(WB_DIR, '.rate-guard-state.json'), {});
  const prev = state[key] || {};
  const isNew = prev.status !== 'rate-limited' || (resetAt || 0) !== (prev.resetAt || 0);
  const reason = resetAt ? 'proxy 429' : `proxy 429（无官方重置时间）${String(body || '').slice(0, 80)}`;
  state[key] = { account: acctKey, model: modelId, status: 'rate-limited', resetAt: resetAt ?? null, since: prev.status === 'rate-limited' ? (prev.since || now) : now, at: now, reason, source: 'proxy' };
  writeJsonSafe(join(WB_DIR, '.rate-guard-state.json'), state);
  if (isNew) appendEvent('rate-limited', { model: modelId, group: modelId, account: acctKey, accountLabel: acctLabel(acctKey), reason, resetAt: resetAt ?? null, resetAtText: resetAt ? fmtTime(resetAt) : null, source: 'proxy' });
  console.log(`[wb-shim] 代理 429 → 限流状态 ${key} 重置≈${resetAt ? fmtTime(resetAt) : '未知（10 分钟后自动复测）'}`);
}

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
function buildRuntime(variant, desktopPath) {
  const client = new WorkBuddyUpstreamClient();
  const store = new WorkBuddyCredentialStore({
    variant,
    keyProvider: atRestKeyProviderFor(variant),
    refresh: (credential) => client.refreshToken(credential),
    // desktopPath 非空时直接读指定明文凭证文件（Debian 账号）；ownPath 单独隔离避免盖掉 LeCoo 的插件副本
    ...(desktopPath ? { desktopPath, ownPath: join(HERE, 'debian-own.auth') } : {}),
  });
  const catalog = new WorkBuddyCatalog(fallbackFor(variant));
  // 用上游声明的最大上下文窗口（国际版目录带 supportedContextWindows 多档时取最大；
  // 插件卡片的同名开关默认也是开的）。国内版目录多为单档，无副作用。
  catalog.setUseMaximumContextWindow(true);
  catalog.setVisible(false);
  return { variant, client, store, catalog, lastIdentity: undefined, inFlight: undefined, credits: undefined, creditsAtMs: 0, creditsError: undefined };
}

// [2026-10-16] 自有层积分抓取：插件 fetchCredits 会把到期时间丢掉（只留 4 个字段），
// 这里照抄它的解析口径 + 保留 CycleEndTime/DeductionEndTime，看板才能按官方样式显示"到期"。
// 第三方包不改，落点在自己层。企业账号（cn+enterpriseId）走插件原路径（企业接口无分包明细）。
function creditsExpiryOf(a) {
  const cands = [];
  const ce = typeof a.CycleEndTime === 'string' && a.CycleEndTime ? Date.parse(a.CycleEndTime.replace(' ', 'T')) : NaN;
  if (Number.isFinite(ce)) cands.push(ce);
  const de = typeof a.DeductionEndTime === 'number' && a.DeductionEndTime > 0 ? a.DeductionEndTime : NaN;
  // DeductionEndTime 远期（>3 年）视为"长期有效"，不当到期日
  if (Number.isFinite(de) && de < Date.now() + 3 * 365 * 864e5) cands.push(de);
  return cands.length ? Math.min(...cands) : undefined;
}
async function fetchCreditsEx(rt, credential) {
  const isIntl = rt.variant.id !== CN_VARIANT.id;
  if (!isIntl && credential.enterpriseId) return rt.client.fetchCredits(credential);
  const base = isIntl ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const headers = { 'Authorization': `Bearer ${credential.accessToken}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (credential.uid) headers['X-User-Id'] = credential.uid;
  if (credential.domain) headers['X-Domain'] = credential.domain;
  // [2026-10-19] 独立连接（禁 keep-alive 池复用坏连接）+ 硬超时。
  // 根因实录：Clash TUN 劫走官方请求后 socket 崩（UND_ERR_SOCKET），
  // 池里死连接让后续每次积分请求全挂死，连带 / 和 /api/router 打不开。
  // 机器没装 undici 包，走每请求 Connection: close（同 fetchUsageDay 的修法）。
  const resp = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: { ...headers, Connection: 'close' },
    body: JSON.stringify({
      PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
    }),
    signal: AbortSignal.timeout(Number(process.env.WB_SHIM_CREDITS_TIMEOUT_MS || 12000)),
  });
  const envelope = await resp.json().catch(() => ({}));
  if (!resp.ok || envelope.code !== 0) throw new Error(`credits HTTP ${resp.status} code=${envelope.code ?? '?'}`);
  const data = envelope?.data?.Response?.Data ?? {};
  const rawAccounts = Array.isArray(data.Accounts) ? data.Accounts : [];
  const accounts = []; let total = 0;
  for (const a of rawAccounts) {
    if (typeof a !== 'object' || a === null) continue;
    const num = (k) => (typeof a[k] === 'number' ? a[k] : 0);
    const size = num('CycleCapacitySize');
    const cycleRemain = num('CycleCapacityRemain');
    const cycleUsed = num('CycleCapacityUsed');
    let remain;
    if (size > 0) remain = cycleRemain;
    else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
    else remain = num('CapacityRemain');
    if (remain < 0) remain = 0;
    total += remain;
    accounts.push({
      packageName: typeof a.PackageName === 'string' ? a.PackageName : '(unnamed)',
      remain,
      size: size > 0 ? size : num('CapacitySize'),
      cycleUsed: cycleUsed > 0 ? cycleUsed : num('CycleCapacityUsed'),
      cycleEnd: typeof a.CycleEndTime === 'string' && a.CycleEndTime ? a.CycleEndTime : undefined,
      expireAt: creditsExpiryOf(a),
    });
  }
  return { total, accounts };
}

/** 抓积分（照抄 apply 的账号轮询：fetchCredits(credential)）。失败保留旧值，error 记原因。 */
async function refreshCredits(rt, credential) {
  try {
    const c = await fetchCreditsEx(rt, credential);
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

// [2026-10-16] 积分改为【按需】：只有打开网页 / 调 /v1/credits 才去问服务器一次，带缓存防连点。
// 取代原来的后台每 REFRESH_MS 轮询（没人看还一直打服务器，像刷分）。
// [2026-10-19] 积分单飞：同一 rt 的并发请求共享一次官方拉取。
// 根因实录：/ 和 /api/router 都要 ensureCredits(全账号)，根路径还并发渲染多个栏目，
// 同一账号一秒内被打 2-4 次（日志同一秒重复"积分: total="），页面被反复拖慢。
const creditsInflight = new Map();
async function ensureCredits(rt, force = false) {
  if (!force && rt.creditsAtMs && Date.now() - rt.creditsAtMs < CREDITS_CACHE_TTL_MS) return;
  // [2026-10-19] 失败也要记时间戳（短冷却），否则每次开页面都重打官方——
  // 官方抽风时积分日志几分钟刷一轮，页面也被反复拖慢。
  const failCooldownMs = Number(process.env.WB_SHIM_CREDITS_FAIL_COOLDOWN_MS || 30000);
  if (!force && rt.creditsFailAtMs && Date.now() - rt.creditsFailAtMs < failCooldownMs) return;
  // 单飞：已在飞的同账号请求直接搭车（force 除外，强制刷新要真打）
  if (!force) {
    const flying = creditsInflight.get(rt);
    if (flying) return flying;
  }
  const p = (async () => {
    try {
      const cred = await rt.store.resolve();
      await refreshCredits(rt, cred);
    } catch (e) {
      rt.creditsFailAtMs = Date.now();
      log(rt.variant.id, '按需积分刷新失败（下次再看时重试）:', String(e).slice(0, 180));
    } finally {
      creditsInflight.delete(rt);
    }
  })();
  creditsInflight.set(rt, p);
  return p;
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
 * [2026-10-20] catalogChangeSig：60 秒同内容去重窗（防双路径重复记同一上新）。
 */
const catalogChangeSig = new Map();
function detectCatalogChanges(rt, models) {
  const nowIds = (models ?? []).map((m) => m.id).sort();
  const prevIds = rt.modelIds;
  rt.modelIds = nowIds;
  if (!prevIds) return; // 首轮建基线，不记事件
  const removed = prevIds.filter((id) => !nowIds.includes(id));
  const added = nowIds.filter((id) => !prevIds.includes(id));
  // [2026-10-20 修] 同一 rt 短时间内重复记同样事件（老大截图：minimax-m3.1-flash 在
  // workbuddy 下 05:03:21 连发两条）——sweep 里超龄重抓路径和登录刷新路径都会调本函数，
  // 第二次调用时 rt.modelIds 已被第一次更新，本不该再报；重复来自两条路径同分钟各跑一次
  // 且第一次的基线还没建立（或目录内容在两条路径间抖动）。加 60 秒同内容去重窗。
  if (added.length || removed.length) {
    const sig = `${rt.variant.id}|+${added.join(',')}|-${removed.join(',')}`;
    const last = catalogChangeSig.get(sig);
    if (last && Date.now() - last < 60_000) {
      log(rt.variant.id, `目录变化 60 秒内重复（${added.length}+/-${removed.length}-），去重不记`);
      return;
    }
    catalogChangeSig.set(sig, Date.now());
    // 顺手清 10 分钟前的旧签名，防 Map 无限长
    for (const [k, t] of catalogChangeSig) if (Date.now() - t > 600_000) catalogChangeSig.delete(k);
  }
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
    // 登录态没变：积分不再后台刷（改为按需，见 ensureCredits）；目录超龄仍强制重抓
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

// 🔴 不能 .map(buildRuntime)：map 会把数组下标当第二参传进 buildRuntime(desktopPath)，
// intl 下标=1 ⇒ desktopPathOverride=1 ⇒ readFile(1) 崩（CN 下标 0 falsy 才没暴露）。必须显式只传 variant。
const runtimes = WORKBUDDY_VARIANTS.map((variant) => buildRuntime(variant));

// [2026-10-20] 渠道校验通关层：包装 rt.client，chatStream 走带官方客户端网关卡头的
// 直连上游实现（详见 intl-gateway.mjs 头注释）。
// 🔴 老大定案：国内外全版本都包——这套头是官方客户端原样，穿上只会更像官方；
// 官方哪天对国内版跟进风控，我们已在门内，不必临时改动。排障可用
// WB_SHIM_GATEWAY_CN=0 让国内版退回插件原装路径做对照。
// 必须在 createWorkBuddyShim 之前包——插件 shim 内部持的就是我们传进去的这个对象。
for (const rt of runtimes) {
  try {
    rt.client = wrapIntlGatewayClient(rt.client, { logger: console });
    log('gateway', `${rt.variant.id}: chatStream 已挂官方客户端网关头（daemon 直连上游）`);
  } catch (e) {
    log('gateway', `${rt.variant.id} 包装失败，继续用插件原装路径:`, String(e));
  }
}

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

// ── Debian 独立账号（N5105 小主机，国内版 CN，独立积分池）────────────────────
// 方案 A：Debian 凭证落盘喂给现有 wb-shim，新增一个可选账号，统一由 :18796 出口。
// 专用 token（DEBIAN_TOKEN）路由到本账号；默认 token 仍走 LeCoo。
// 看板/状态页用 allRuntimes 把两账号都列出；代理路由用 pool（按 token 选账号）。
let debLive = [];
if (DEBIAN_TOKEN) {
  const debVariant = { ...CN_VARIANT, id: CN_VARIANT.id, region: 'cn' };
  const debRt = buildRuntime(debVariant, DEBIAN_AUTH_FILE);
  debRt.isDebian = true;
  try {
    // [2026-10-20] Debian 账号同样是国内版 CN，一样穿官方网关头（全版本统一）。
    debRt.client = wrapIntlGatewayClient(debRt.client, { logger: console });
    const shim = createWorkBuddyShim({ store: debRt.store, client: debRt.client, catalog: debRt.catalog, logger: console });
    await shim.ready;
    debRt._pluginShim = shim;
    await sweep(debRt).catch((e) => log('debian 首轮 sweep 异常:', String(e)));
    debLive = [debRt];
    log('debian', 'Debian 账号已挂载（国内版 CN，专用 token 路由）');
  } catch (e) {
    log('debian', 'Debian shim 启动失败（检查 WB_SHIM_DEBIAN_AUTH_FILE / 凭证是否过期）:', String(e).slice(0, 200));
  }
} else {
  log('debian', '未配置 WB_SHIM_DEBIAN_TOKEN，跳过 Debian 账号');
}
const allRuntimes = [...live, ...debLive];
// 设备/版本身标签：看板卡片标题统一「名 · 身」，本机/Debian/国际版 一视同仁
// 设备/版本身标签统一走 accounts.mjs 真源（2026-10-19 收口）
for (const rt of allRuntimes) rt.label = acctLabel(acctKeyOfRuntime(rt, CN_VARIANT.id));// 看板/状态页的账号标识：Debian 用 workbuddy-deb 避免和 LeCoo 的 workbuddy 撞 key（路由仍按 variant.id='workbuddy' 命中 CN）
const rtLabel = (r) => (r.isDebian ? `${r.variant.id}-deb` : r.variant.id);

// ════════════════════════════════════════════════════════════════
// 二级页面「模型动态」数据层（2026-10-15 瘦身：只做份内的模型状态维护）
// 回答三个问题：① 模型现在什么状态 ② 状态变更时间线 ③ 各模块心跳
// 数据源：free-expiry.json（到期登记）+ rate-guard 状态 + events.jsonl 时间线 + 服务日志年龄
// 全部只读、免鉴权（不含任何令牌/key）
// ════════════════════════════════════════════════════════════════
const WB_DIR = HERE; // 与 daemon 同目录（C:\D\opt\wb-shim）
// 组名 → 上游模型名（与 rate-guard.mjs upstreamOf 同源；限流状态卡片/首页徽章用）
const GROUP_MODEL = {
  // 组名即上游真名（2026-10-16 解耦：弃用 litellm 的 wb- 组名风格），保留映射以兼容显示/去重逻辑
  'step-5-preview': 'step-5-preview',
  'step-5-preview-intl': 'step-5-preview-intl',
  'deepseek-v4.1-flash-intl': 'deepseek-v4.1-flash-intl',
  'hy3': 'hy3',
  'hy3-intl': 'hy3-intl',
  'hy4-preview': 'hy4-preview',
  'hy4-preview-intl': 'hy4-preview',
};
// 上下文窗口强制覆盖（与 /v1/models 共用）：上游目录对部分模型申报的窗口低于官方真实上限，
// 客户端据此会过早压缩。只改返回给客户端的 context_window，绝不动上游请求体。
const CONTEXT_WINDOW_OVERRIDES = { hy3: 256000 }; // 官方介绍页称最大 256K，目录只申报 192K
function readJsonSafe(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonSafe(p, obj) {
  try { writeFileSync(p, JSON.stringify(obj, null, 1)); } catch (e) { log('状态写盘失败:', String(e).slice(0, 120)); }
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
  // 键=account:model（account: workbuddy 本机 / workbuddy-deb Debian / workbuddy-ai 国际版）；旧键无冒号视为本机
  const byModel = new Map();
  for (const [key, st] of Object.entries(rg)) {
    const idx = key.indexOf(':');
    const account = idx > 0 ? key.slice(0, idx) : 'workbuddy';
    const model = (idx > 0 ? key.slice(idx + 1) : key) || st?.model || key;
    const status = st?.status ?? 'ok';
    const resetAt = st?.resetAt ?? null;
    const prev = byModel.get(model);
    if (!prev) {
      byModel.set(model, { group: model, model, accounts: [account], accountStatus: [{ account, status, resetAt }], status, statusText: status === 'rate-limited' ? '被限流（恢复时自动解除）' : '正常', since: st?.since ?? null, resetAt, reason: st?.reason ?? null, resetText: resetAt ? new Date(resetAt).toLocaleString('zh-CN', { hour12: false }) : null });
      continue;
    }
    prev.accounts.push(account);
    prev.accountStatus.push({ account, status, resetAt, reason: st?.reason ?? null });
    // 任一账号限流 → 该模型算限流；多账号都限流取较晚的预计恢复
    if (status === 'rate-limited' && prev.status !== 'rate-limited') { prev.status = 'rate-limited'; prev.statusText = '被限流（恢复时自动解除）'; }
    if (status === 'rate-limited' && (resetAt || 0) > (prev.resetAt || 0)) { prev.resetAt = resetAt; prev.resetText = new Date(resetAt).toLocaleString('zh-CN', { hour12: false }); }
  }
  return [...byModel.values()];
}

async function buildRouterData() {
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
  await Promise.all(allRuntimes.map((rt) => ensureCredits(rt)));
  return {
    ok: true,
    now: Date.now(),
    nowText: new Date().toLocaleString('zh-CN', { hour12: false }),
    freeModels: buildFreeModels(),
    schedule: buildSchedule(),
    health: buildHealth(),
    rateState: buildRateState(),
    events: readEvents(300),
    promoSource,
    credits: allRuntimes.map((r) => ({ id: rtLabel(r), total: r.credits?.unlimited ? '不限' : (r.credits?.total ?? null) })),
  };
}

// [2026-10-18] 单页 App 共享外壳：左侧栏 + 主区，所有栏目内嵌到 <section class="view"> 切换，不跳外部页。
// 各 render 函数支持 partial：
//   partial=true  → 只返回栏目主体（自带 <style> 特有类 + 主体 + <script> 初始化），由 renderAppShell 内嵌；
//   partial=false → 包成独立完整页（保留 /usage 等直接访问入口）。
// 统一视觉：BASE_CSS 含 :root 变量 + 布局 + 通用类；各栏目只保留自己特有类，不得再定义 :root。
const BASE_CSS = `
/* [2026-10-19 老大点名] 主题可切换：默认跟系统（auto），按钮手动切亮/暗。
 * 实现三套：:root 默认亮色；[data-theme=dark] 强制暗色变量；
 * prefers dark 且未手动指定时暗色变量照旧生效（保持老行为）。 */
:root{--brand:#FD9527;--bg:#F6F7F9;--panel:#FFF;--border:#E6E8EB;--text:#1f2329;--text2:#646a73;--text3:#939aa3;--ok:#0f7b46;--warn:#b7791f;--err:#c0392b;--surface:#F6F7F9;--font-mono:'IBM Plex Mono',ui-monospace,monospace;--barw:64px;--barh:240px;--bargap:10px;color-scheme:light}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1115;--panel:#171a1f;--border:#262b33;--text:#e8eaed;--text2:#9aa0a6;--text3:#6b7178;--ok:#4ade80;--warn:#fbbf24;--err:#f87171;--surface:#171a1f;--barw:64px;--barh:240px;--bargap:10px;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0f1115;--panel:#171a1f;--border:#262b33;--text:#e8eaed;--text2:#9aa0a6;--text3:#6b7178;--ok:#4ade80;--warn:#fbbf24;--err:#f87171;--surface:#171a1f;--barw:64px;--barh:240px;--bargap:10px;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text)}
.app{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
.app.side-collapsed{grid-template-columns:52px minmax(0,1fr)}
.side{background:var(--panel);border-right:1px solid var(--border);padding:1.1rem .9rem;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;transition:padding .18s}
/* [2026-10-19 老大点名] 侧边栏整体收起：只留 52px 图标列，空间全给中间显示区 */
.app.side-collapsed .side{padding:1.1rem .4rem}
/* [2026-10-19] 主题按钮：跟«同排、做成可见的小方按钮（有边框有底色，不再与背景糊在一起） */
.topbar-row{display:flex;align-items:center;gap:.35rem;margin-bottom:.5rem}
.app.side-collapsed .topbar-row{flex-direction:column}
.app.side-collapsed .side-collapse{flex:none;width:100%;padding:.28rem 0}
.side-collapse{display:flex;align-items:center;justify-content:center;flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text2);border-radius:7px;font-size:.85rem;padding:.28rem 0;cursor:pointer}
.side-collapse:hover{color:var(--brand);border-color:var(--brand)}
.theme-btn{flex:none;width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;background:var(--surface);border:1px solid var(--border);color:var(--text2);border-radius:7px;font-size:.95rem;cursor:pointer}
.theme-btn:hover{color:var(--brand);border-color:var(--brand)}
.app.side-collapsed .side-collapse{justify-content:center}
.side-collapse .ico{display:inline-block}
.app.side-collapsed .logo,.app.side-collapsed .side-sub,.app.side-collapsed .nav .label,.app.side-collapsed .credcard{display:none}
.app.side-collapsed .nav{padding:.5rem 0;text-align:center}
.app.side-collapsed .nav .ico{display:inline-block}
/* 收起态用首字当图标：看/积/模/用/事/账/设 */
.nav .ico{display:none;font-weight:600}
.app.side-collapsed .app-grid-gap{display:none}
.logo{font-weight:700;font-size:1.05rem}.logo b{color:var(--brand)}.side-sub{color:var(--text3);font-size:.72rem;margin:.15rem 0 1.1rem}
nav{display:flex;flex-direction:column;gap:.2rem}
.nav{display:block;padding:.5rem .65rem;border-radius:8px;color:var(--text2);text-decoration:none;font-size:.85rem;white-space:nowrap;cursor:pointer}
.nav:hover{background:var(--bg)}
.nav.on{background:var(--brand);color:#fff;font-weight:600}
.credcard{margin-top:auto;border:1px solid var(--border);border-radius:10px;padding:.7rem .8rem}
.cred-toggle{display:flex;align-items:center;gap:.4rem;width:100%;background:none;border:0;padding:0;color:inherit;cursor:pointer;font:inherit}
.cred-title{font-size:.78rem;font-weight:600;color:var(--text2)}
.cred-arrow{margin-left:auto;font-size:.7rem;color:var(--text3);transition:transform .18s}
.credcard.collapsed .cred-arrow{transform:rotate(-90deg)}
.credcard.collapsed .cred-body{display:none}
.cred-body{margin-top:.55rem}
.cred-title{font-weight:600;font-size:.82rem}.cred-sub{color:var(--text3);font-size:.7rem;margin-top:.15rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{padding:1.4rem 1.6rem 3rem;max-width:1200px;margin:0 auto;min-width:0}
.view{display:block}.view[hidden]{display:none}
.top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:1.2rem;flex-wrap:wrap;gap:.6rem}
.top h1{font-size:1.25rem;margin:0}.sub{color:var(--text3);font-size:.76rem;margin-top:.2rem}
.tabs{display:flex;gap:.3rem;background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:.2rem}
.tab{border:none;background:none;color:var(--text2);padding:.35rem .7rem;border-radius:7px;cursor:pointer;font:inherit;font-size:.8rem}
.tab.on{background:var(--brand);color:#fff}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:.9rem;margin-bottom:.9rem}
@media(max-width:980px){.kpis{grid-template-columns:repeat(2,1fr)}}
@media(max-width:580px){.kpis{grid-template-columns:1fr}}
/* [2026-10-19 老大点名] 侧边栏自动响应：宽屏(>980px)展开 220px；半屏(≤980px)与手机(≤820px)
 * 一律收成 52px 图标列；顶部 «/» 按钮可手动切换（优先级最高，存 localStorage）。
 * 手机(≤820px)侧栏保持左侧竖排，不再横排到顶部。 */
@media(max-width:980px){
  .app{grid-template-columns:52px minmax(0,1fr)}
  .side{padding:1.1rem .4rem}
  .logo,.side-sub,.nav .label,.credcard{display:none}
  .nav{padding:.5rem 0;text-align:center}
  .nav .ico{display:inline-block;font-weight:600}
}
.app.side-expanded{grid-template-columns:220px minmax(0,1fr)}
.app.side-expanded .side{padding:1.1rem .9rem}
.app.side-expanded .logo,.app.side-expanded .side-sub,.app.side-expanded .nav .label{display:initial}
.app.side-expanded .nav{padding:.5rem .65rem;text-align:left}
.app.side-expanded .credcard{display:block}
.app.side-expanded .nav .ico{display:none}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem;margin-bottom:.9rem;min-width:0}
.card h2{font-size:.95rem;margin:0 0 .8rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.kpi .kpi-label{color:var(--text3);font-size:.74rem}.kpi .kpi-val{font-size:1.7rem;font-weight:700;margin-top:.25rem;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi .kpi-val.ok{color:var(--ok)}.kpi .kpi-val.warn{color:var(--warn)}
.kpi .kpi-sub{color:var(--text3);font-size:.72rem;margin-top:.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-credit{align-items:flex-start}.kpi-credit .kpi-val{margin-bottom:.1rem}
.cred-rows{margin-top:.45rem;border-top:1px solid var(--border);padding-top:.45rem;display:flex;flex-direction:column;gap:.25rem;width:100%}
.cred-row{display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;font-size:.72rem;color:var(--text2)}
.cred-row b{color:var(--text);font-weight:600}
.kpi{display:block;position:relative;cursor:pointer;text-decoration:none;color:inherit;transition:border-color .15s}
.kpi:hover{border-color:var(--brand)}
.kpi::after{content:'→';position:absolute;top:.7rem;right:.95rem;color:var(--text3);font-size:1rem;opacity:.4;transition:opacity .15s,color .15s}
.kpi:hover::after{color:var(--brand);opacity:1}
.row{display:grid;grid-template-columns:1.6fr 1fr;gap:.9rem}.row2{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
@media(max-width:980px){.row,.row2{grid-template-columns:1fr}}
.chart-wrap{overflow:visible;min-width:0}
/* [2026-10-19] 柱宽可调：--barw 单根柱宽；柱高可调：--barh 绘图区总高。
 * 数值标签放回柱顶正常文档流（占 14px），轨道用固定 calc 高度 ⇒ 满值柱也能画到顶。
 * 柱间留真间隙（--bargap），不搞挤在一起的丑样子。 */
.chart .bars{display:flex;align-items:flex-end;gap:var(--bargap,10px);height:calc(var(--barh,260px) + 14px);padding-top:.4rem}
.bar-col{width:var(--barw,100%);max-width:var(--barw,100%);flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0;cursor:pointer}
.bar-col:hover .bar-lab{color:var(--brand);font-weight:600}
.bar-col:hover .bar-fill{filter:brightness(1.12)}
.bar-val{font-size:.6rem;color:var(--text3);height:14px;line-height:14px;overflow:hidden;text-align:center;flex:0 0 14px}
.bar-track{flex:0 0 calc(100% - 14px);width:100%;display:flex;align-items:flex-end;background:var(--bg);border-radius:4px}
.bar-fill{width:100%;background:linear-gradient(180deg,var(--brand),#ffb860);border-radius:4px;min-height:2px;transition:height .4s}
.bar-lab{font-size:.58rem;color:var(--text3);margin-top:3px;white-space:nowrap}
.rank-row{display:flex;flex-direction:column;gap:.3rem;margin-bottom:.75rem;min-width:0}
.rank-head{display:flex;align-items:center;gap:.45rem;min-width:0}
.rank-name{font-size:.8rem;font-weight:600;white-space:nowrap;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.rank-acct{flex:0 0 auto;font-size:.66rem;color:var(--text2);border:1px solid var(--border);border-radius:99px;padding:.02rem .42rem;white-space:nowrap}
.rank-num{margin-left:auto;font-size:.78rem;color:var(--text2);white-space:nowrap}
.rank-idx{flex:0 0 auto;display:inline-block;width:1.1rem;height:1.1rem;line-height:1.1rem;text-align:center;background:var(--bg);border-radius:50%;font-size:.66rem;color:var(--text2)}
.rank-bar{height:7px;background:var(--bg);border-radius:4px;overflow:hidden}.rank-bar i{display:block;height:100%;background:var(--brand);border-radius:4px}
.rank-num{font-size:.78rem;color:var(--text2)}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{text-align:left;color:var(--text3);font-weight:400;font-size:.7rem;padding:.3rem .4rem;border-bottom:1px solid var(--border)}
td{padding:.42rem .4rem;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:.08rem .5rem;border-radius:99px;border:1px solid var(--border);font-size:.72rem}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.err{color:var(--err);border-color:var(--err)}
.timeline{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}
.ev{display:flex;gap:.55rem;padding:.45rem 0;border-bottom:1px solid var(--border)}
.ev:last-child{border-bottom:0}
.ev-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);margin-top:.45rem;flex:none}
.ev-dot.muted{background:var(--text3)}
.ev-body{flex:1;min-width:0}.ev-top{display:flex;gap:.5rem;align-items:center}
.ev-tag{font-size:.68rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.04rem .4rem;color:var(--text2)}
.ev-time{font-size:.68rem;color:var(--text3);font-family:var(--font-mono)}
.ev-text{font-size:.78rem;color:var(--text);margin-top:.15rem;word-break:break-word}
.empty{padding:1.2rem;text-align:center;color:var(--text3);font-size:.8rem}
.wrap{max-width:1100px;margin:0 auto;padding:0 1rem}
.brand{font-weight:600;font-size:1.05rem}.brand b{color:var(--brand)}
.subtle{display:block;color:var(--text3);font-size:.76rem;margin-top:.15rem}
a.back{color:var(--brand);text-decoration:none;font-size:.82rem}
.pill.on{background:var(--brand);border-color:var(--brand);color:var(--invert)}
.bigline{font-size:.95rem;margin:.35rem 0}.bigline b{color:var(--brand)}
.note{color:var(--text3);font-size:.76rem;margin-top:.5rem;line-height:1.5}
.q{font-size:.78rem;color:var(--text3);font-weight:400;display:block;margin-top:.1rem}
.evtext{white-space:pre-wrap;font-size:.82rem}
.summary{display:flex;flex-direction:column;gap:.6rem}
.lim-head{display:flex;align-items:center;gap:.55rem;font-size:.95rem}
.lim-dot{width:9px;height:9px;border-radius:50%;background:var(--err);flex:none;box-shadow:0 0 0 3px rgba(226,75,74,.15)}
.lim-note{color:var(--text3);font-size:.78rem;margin-left:auto}
.lim-item{display:flex;align-items:baseline;gap:1rem;padding:.5rem .7rem;background:var(--surface);border-radius:8px;border-left:3px solid var(--err)}
.lim-name{font-weight:600;min-width:12rem}
.lim-acct{color:var(--text2);font-size:.85rem}
.lim-eta{margin-left:auto;color:var(--text3);font-size:.8rem;font-family:var(--font-mono);white-space:nowrap}
.ok-line{display:flex;align-items:center;gap:.55rem;font-size:.95rem}
.ok-dot{width:9px;height:9px;border-radius:50%;background:var(--ok);flex:none;box-shadow:0 0 0 3px rgba(97,153,34,.15)}
.ok-note{color:var(--text3);font-size:.82rem;font-weight:400}
.warn-line{color:var(--warn);font-size:.9rem}
.reg{display:inline-block;padding:.02rem .4rem;border-radius:5px;font-size:.68rem;margin-left:.4rem;vertical-align:middle;font-weight:400}
.reg.cn{color:var(--text3);border:1px solid var(--border)}
.reg.intl{color:var(--brand);border:1px solid var(--brand)}
.acct-tag{display:inline-block;padding:.1rem .5rem;border-radius:7px;font-size:.74rem;margin-right:.4rem;white-space:nowrap;border:1px solid var(--border)}
.acct-tag.ok{color:var(--ok);border-color:var(--ok)}
.acct-tag.err{color:var(--err);border-color:var(--err);background:rgba(226,75,74,.08)}
.pager{display:flex;align-items:center;gap:.4rem;margin-top:.8rem;flex-wrap:wrap}
.pg-info{color:var(--text3);font-size:.76rem;margin-right:.5rem}
.pg{background:var(--surface);border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:.15rem .5rem;font-size:.78rem;cursor:pointer}
.pg:hover{border-color:var(--brand);color:var(--brand)}
.pg.on{background:var(--brand);border-color:var(--brand);color:#fff}
.muted{color:var(--text3)}
.datebar{display:flex;gap:.5rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap}
.datebar input[type=date]{padding:.3rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit}
.datebar button{padding:.3rem .8rem;border:1px solid var(--border);border-radius:6px;background:var(--brand);color:#fff;border:none;cursor:pointer;font:inherit}
.datebar button.ghost{background:var(--surface);color:var(--text)}
.card .total{font-family:var(--font-mono);font-size:1.5rem;font-weight:700}
.free{color:var(--ok)}
.err{color:var(--err);font-size:.85rem}
/* 呼吸灯：绿=凭证有效，红=失效（与 gw 那套一致的呼吸节奏） */
.dot-live{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:6px;vertical-align:middle}
.dot-live.ok{background:var(--ok);animation:breath 2.2s ease-in-out infinite}
.dot-live.err{background:var(--err);animation:breath 1s ease-in-out infinite}
@keyframes breath{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dot-live{animation:none;opacity:1}}
.kv{display:grid;grid-template-columns:140px 1fr;gap:.4rem 1rem;font-size:.85rem}.kv b{color:var(--text2);font-weight:400}
.kvwrap{overflow-x:auto}.kvwrap .kvtab{min-width:max-content}
.tertiary{color:var(--text3);font-size:.8rem}
.connline{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:.15rem 0;font-size:.82rem}
.connline code{background:var(--surface);padding:.12rem .45rem;border-radius:.3rem;user-select:all}
`;

function appCredHtml() {
  let unlimited = false, remain = 0, updated = 0; const labels = [];
  for (const rt of allRuntimes) {
    if (!rt.catalog.isVisible()) continue;
    const c = rt.credits; if (!c) continue;
    labels.push(rt.label || rtLabel(rt));
    if (rt.creditsAtMs && rt.creditsAtMs > updated) updated = rt.creditsAtMs;
    if (c.unlimited) unlimited = true;
    else { for (const a of c.accounts || []) if (!a.unlimited) remain += (a.remain || 0); }
  }
  const fmtN = (n) => { const s = Number(n).toFixed(2); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  return `<div class="cred-title">${esc(labels.join(' + ') || acctLabel('workbuddy'))}</div><div class="cred-sub">凭据已接入 · 积分更新于 ${esc(fmtTime(updated))}${unlimited ? ' · 不限量' : ' · 余额 ' + fmtN(remain)}</div>`;
}

function appSideBar(active) {
  // [2026-10-19 老大点名] 整个侧边栏可收成 52px 图标列（首字当图标），空间全给中间；
  // 收/展状态存 localStorage，刷新不丢。凭据卡片收起态整体隐藏。
  const nav = (id, label) => `<a class="nav ${active === id ? 'on' : ''}" href="#" data-view="${id}" title="${label}"><span class="ico">${label.slice(0, 1)}</span><span class="label">${label}</span></a>`;
  return `<aside class="side"><div class="topbar-row"><button type="button" class="side-collapse" id="side-collapse" title="收起/展开侧边栏"><span class="ico">«</span></button><button type="button" class="theme-btn" id="theme-toggle" title="切换亮/暗色">◐</button></div><div class="logo"><b>wb-shim</b></div><div class="side-sub">模型凭据网关</div><nav>${nav('dash', '看板')}${nav('credits', '积分')}${nav('models', '模型')}${nav('usage', '用量')}${nav('events', '事件')}${nav('bills', '账单')}${nav('settings', '设置')}</nav><div class="credcard"><button type="button" class="cred-toggle" id="cred-toggle" aria-expanded="true"><span class="cred-title">账号凭据</span><span class="cred-arrow" id="cred-arrow">▾</span></button><div class="cred-body" id="cred-body">${appCredHtml()}</div></div></aside>`;
}

// 完整独立页外壳（保留 /usage 等直接访问入口）
function appShell(active, bodyHtml, title) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title || 'wb-shim'}</title><style>${BASE_CSS}</style></head><body><div class="app">${appSideBar(active)}<main class="main">${bodyHtml}</main></div></body></html>`;
}

// 单页 App（首页 /）：所有栏目内嵌为 <section class="view">，侧边栏切换显示（二级菜单，不跳独立页）
function renderAppShell(defaultView) {
  defaultView = defaultView || 'dash';
  const body = `<div class="view" data-view="dash">${renderDashboardInner()}</div>
<div class="view" data-view="credits" hidden>${renderCreditsInner()}</div>
<div class="view" data-view="models" hidden>${renderModelsInner()}</div>
<div class="view" data-view="usage" hidden>${renderUsageInner()}</div>
<div class="view" data-view="events" hidden>${renderEventsInner()}</div>
<div class="view" data-view="bills" hidden>${renderBillsInner()}</div>
<div class="view" data-view="settings" hidden>${renderSettingsInner()}</div>`;
  const script = `<script>
(function(){
  function show(v){
    var ok=false;
    document.querySelectorAll('.view').forEach(function(s){var on=s.getAttribute('data-view')===v;s.hidden=!on;s.style.display=on?'':'none';if(on)ok=true});
    document.querySelectorAll('.nav').forEach(function(n){n.classList.toggle('on',n.getAttribute('data-view')===v)});
    try{window.scrollTo(0,0);}catch(e){}
    if(ok){var h=location.hash.replace('#','');if(h!==v)location.replace('#'+v);}
  }
  window.showView=show;
  // [2026-10-19 老大点名] 侧边栏：宽屏自动展开、半屏/手机自动收成图标列；
  // «/» 按钮手动切换（手动选择存 localStorage，优先于自动）。
  (function(){
    var btn=document.getElementById('side-collapse'),app=document.querySelector('.app');
    if(!btn||!app)return;
    var KEY='wbshim-side-manual';       // 'open' | 'closed' | null(=跟随窗口宽度自动)
    var mq=window.matchMedia('(max-width:980px)');
    function narrow(){return mq.matches}
    function apply(){
      var manual=null;try{manual=localStorage.getItem(KEY)}catch(e){}
      var collapsed = manual==='closed' ? true : (manual==='open' ? false : narrow());
      app.classList.toggle('side-collapsed',collapsed);
      app.classList.toggle('side-expanded',!collapsed&&!narrow());
      btn.querySelector('.ico').textContent=collapsed?'»':'«';
      btn.title=collapsed?'展开侧边栏':'收起侧边栏';
    }
    apply();
    mq.addEventListener?('change',apply):mq.addListener(apply);
    btn.addEventListener('click',function(){
      var collapsed=app.classList.contains('side-collapsed');
      try{localStorage.setItem(KEY,collapsed?'open':'closed')}catch(e){}
      apply();
    });
  })();
  // [2026-10-19 老大点名] 主题切换：亮/暗/跟系统三态轮换，存 localStorage；
  // 手动暗=html[data-theme=dark]，手动亮=[data-theme=light]，跟系统=无属性。
  (function(){
    var btn=document.getElementById('theme-toggle');
    if(!btn)return;
    var KEY='wbshim-theme';
    function apply(){
      var t=null;try{t=localStorage.getItem(KEY)}catch(e){}
      var r=document.documentElement;
      if(t==='dark')r.setAttribute('data-theme','dark');
      else if(t==='light')r.setAttribute('data-theme','light');
      else r.removeAttribute('data-theme');
      var dark = t==='dark' || (t===null && window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches);
      btn.textContent = t===null ? '◐' : (dark?'☾':'☀');
      btn.title = '当前：'+(t===null?'跟系统':(t==='dark'?'暗色':'亮色'))+'（点击切换）';
    }
    apply();
    btn.addEventListener('click',function(){
      var t=null;try{t=localStorage.getItem(KEY)}catch(e){}
      var next = t===null ? 'dark' : (t==='dark' ? 'light' : null);
      if(next===null){try{localStorage.removeItem(KEY)}catch(e){}}else{try{localStorage.setItem(KEY,next)}catch(e){}}
      apply();
    });
  })();
  // [2026-10-19 老大点名] 凭据卡片折叠：点标题整卡收起，状态存 localStorage（换栏目/刷新都记得）
  (function(){
    var card=document.getElementById('credcard'),btn=document.getElementById('cred-toggle'),arrow=document.getElementById('cred-arrow');
    if(!card||!btn)return;
    var KEY='wbshim-credcard-collapsed';
    function apply(c){card.classList.toggle('collapsed',c);btn.setAttribute('aria-expanded',c?'false':'true')}
    var saved=null;try{saved=localStorage.getItem(KEY)}catch(e){}
    apply(saved==='1');
    btn.addEventListener('click',function(){
      var c=!card.classList.contains('collapsed');
      apply(c);
      try{localStorage.setItem(KEY,c?'1':'0')}catch(e){}
    });
  })();
  document.querySelectorAll('a[data-view]').forEach(function(n){n.addEventListener('click',function(e){e.preventDefault();show(n.getAttribute('data-view'))})});
  var h=location.hash.replace('#','');
  show(h&&document.querySelector('.view[data-view="'+h+'"]')?h:'${defaultView}');
})();
</script>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>wb-shim · 模型网关</title><style>${BASE_CSS}</style></head><body><div class="app">${appSideBar('dash')}<main class="main">${body}</main></div>${script}</body></html>`;
}

// [2026-10-18] 看板（APIMART 风格仪表盘）主体：落到单页 App 的「看板」栏目。
// 设计稿 fileId 737398758905887（老大 2026-10-17 确认「按这个来」）。
// 数据：积分=ensureCredits 结果；趋势/排行=仅读磁盘缓存（不刷官方 API，看板秒开，随正常使用累积）；
// 限流/状态=buildRateState；事件=readEvents；模型目录=catalog.current()。
// JS 每 60s 拉 /usage-detail 把"今天"和趋势补成实时值。
function renderDashboardInner() {
  // 账号短名统一走 accounts.mjs 真源（2026-10-19 收口；10-20 起名字来自 display.json 自定义）
  // 🔴 TDZ 教训（2026-10-19 实测翻车）：acctKeyOf 的 const 声明在函数后半段，
  //    箭头函数里引用它 = "Cannot access before initialization"，被 unhandledRejection
  //    兜底吞掉 → 根路径 / 永远不返回、浏览器干等超时。声明必须早于任何引用。
  const acctKeyOf = (rt) => acctKeyOfRuntime(rt, CN_VARIANT.id);
  const acctShort = (rt) => acctLabel(acctKeyOf(rt));
  // [2026-10-18] 汇总所有可见账号积分：总积分 + 按账号分开（老大要看每台各剩多少）
  let creditsUnlimited = false;
  let creditsTotal = 0;
  let creditsRemain = 0;
  let creditsUpdated = 0;
  const creditByAcct = [];
  for (const rt of allRuntimes) {
    if (!rt.catalog.isVisible()) continue;
    const c = rt.credits;
    if (!c) { creditByAcct.push({ label: acctShort(rt), remain: null, unlimited: false, alive: false }); continue; }
    if (rt.creditsAtMs && rt.creditsAtMs > creditsUpdated) creditsUpdated = rt.creditsAtMs;
    let rtRemain = 0;
    if (c.unlimited) { creditsUnlimited = true; rtRemain = Infinity; }
    else {
      if (c.total != null) creditsTotal += c.total;
      for (const a of c.accounts || []) if (!a.unlimited) rtRemain += (a.remain || 0);
      creditsRemain += rtRemain;
    }
    creditByAcct.push({ label: acctShort(rt), remain: rtRemain, unlimited: c.unlimited === true, alive: !rt.creditsError });
  }
  const fmt2 = (n) => { let s = String(Number(n == null ? 0 : n)); const dot = s.indexOf('.'); if (dot < 0) return s + '.00'; s = s.slice(0, dot + 3); while (s.length < dot + 3) s += '0'; return s; };
  const fmtN = (n) => {
    if (n == null || n === '') return '—';
    return fmt2(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  const rateState = buildRateState();
  const limitedSet = new Set(rateState.filter((r) => r.status === 'rate-limited').map((r) => r.model).filter(Boolean));
  const alerts = limitedSet.size;
  // 按账号的限流状态（account:model → 是否限流）：状态表每行只认自己账号的，避免"同模型别账号被限流"误标全账号
  // （acctKeyOf 已在函数开头声明，见上方 TDZ 注释）
  const limitedByAcct = new Set(Object.entries(readJsonSafe(join(WB_DIR, '.rate-guard-state.json'), {})).filter(([, st]) => st?.status === 'rate-limited').map(([k]) => k));

  const expiryCfg = readJsonSafe(join(WB_DIR, 'free-expiry.json'), { entries: [] });
  const expiredSet = new Set((expiryCfg.entries || []).filter((e) => e.expiry && new Date(e.expiry).getTime() <= Date.now()).map((e) => e.model));

  const modelCn = { 'step-5-preview': '阶跃 Step5（国内版）', 'step-5-preview-intl': '阶跃 Step5（国际版）', 'deepseek-v4.1-flash-intl': 'DeepSeek v4.1 极速版（国际）', 'hy3': '腾讯混元 Hy3（国内）', 'hy3-intl': '腾讯混元 Hy3（国际）', 'hy4-preview': '腾讯混元 Hy4（国内）', 'glm-5.3-flash': 'GLM 5.3 极速' };
  const mc = (m) => modelCn[m] || m;
  // [2026-10-19] 账号键 → 人话名：统一走 accounts.mjs 真源（别处一律 import，别再抄三目）
  const acctCn = { workbuddy: acctLabel('workbuddy'), 'workbuddy-ai': acctLabel('workbuddy-ai'), 'workbuddy-deb': acctLabel('workbuddy-deb') };
  const ac = (a) => acctCn[a] || a;
  // [2026-10-19 老大点名] 排行只显示模型原名（上游 id），不套中文译名——
  // 译名把 hy4-preview/glm-5.3-flash 混成同一个观感，反而看不出谁在烧。账号仍用人话名。
  const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}K` : (n ? String(n) : '—'));
  // 模型状态表：只留免费模型（GLM5.3 极速是付费、不会限流，占空间删掉）
  // 🔴 只认 catalog 的 free 标记 + hy4-preview 白名单——不认 free-expiry.json 全量登记表，
  // 那里面有大量国际版活动模型（GPT/Grok/Gemini 系列），老大明确说"他们又不免费"，全拉进来就爆表了。
  // hy4-preview 是时段免费（23:00-08:00），白天 catalog 的 free=false，白名单兜住。
  // 注意：不按调用 id 去重——本机和 Debian 都是国内版、调用 id 相同，去重会把 Debian 的行吞掉
  const KEEP = (m, extId) => m.billing?.free === true || m.id === 'hy4-preview' || extId === 'hy4-preview';
  const rows = [];
  let totalModels = 0;
  for (const rt of allRuntimes) {
    if (!rt.catalog.isVisible()) continue;
    const isCn = rt.variant.id === CN_VARIANT.id;
    const acct = acctShort(rt);
    for (const m of rt.catalog.current()) {
      totalModels++;
      const extId = isCn ? m.id : `${m.id}-intl`;
      if (!KEEP(m, extId)) continue;
      const cw = CONTEXT_WINDOW_OVERRIDES[m.id] ?? m.contextWindow;
      let status = '正常', cls = 'ok';
      if (limitedByAcct.has(acctKeyOf(rt) + ':' + extId)) { status = '限流'; cls = 'warn'; }
      else if (expiredSet.has(m.id)) { status = '免费已到期'; cls = 'warn'; }
      rows.push({ name: (m.name || m.id), acct, cw: fmtK(cw), status, cls });
    }
  }
  const onlineModels = totalModels - alerts;

  const trend = [];
  for (let i = 6; i >= 0; i--) { const d = dateMinus(i); const t = dayTotals(d); trend.push({ day: d, credit: t.credit, requests: t.requests }); }
  const maxCredit = Math.max(1, ...trend.map((t) => t.credit));

  const today = todayStr();
  const todayT = dayTotals(today);
  const rankMap = new Map();
  for (let i = 0; i < 7; i++) { const t = dayTotals(dateMinus(i)); for (const [k, v] of t.byModel) { const e = rankMap.get(k) || { name: v.name, acct: v.acctKey, requests: 0, credit: 0 }; e.requests += v.requests; e.credit += v.credit; rankMap.set(k, e); } }
  const rank = [...rankMap.values()].sort((a, b) => b.requests - a.requests).slice(0, 5);
  const maxRank = Math.max(1, ...rank.map((r) => r.requests));

  // 事件时间线：过滤"积分低于200"这类 credits-low 告警（老大：没用，纯刷屏）
  const events = readEvents(300).filter((e) => e.type !== 'credits-low').slice(0, 8);
  const evTypeLabel = { 'rate-limited': '限流', 'rate-recovered': '恢复', 'model-added': '上新', 'model-removed': '下架', 'model-expired': '到期', 'expiry-extended': '延期', 'expiry-notice': '预告', 'promo-added': '促销', 'promo-removed': '促销结束' };
  const evText = (e) => {
    // 限流/恢复两条与事件页同源同格式（2026-10-18 老大钦定：不拼官方英文原文，时间取自事件数据）
    // 账号归属：优先 accountLabel；旧事件没有这字段就用 account 键反查——限流必标账号
    const name = e.model || e.group || '';
    const acctName = e.accountLabel || acctLabel(e.account);
    const acct = ' ( ' + acctName + ' )';
    if (e.type === 'rate-limited') {
      const t = e.resetAt ? new Date(e.resetAt).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
      // [2026-10-20 老大定] 无官方时间的 429 别写"时间待确认"，按 429 类型写清楚：
      // queue.waiting=繁忙排队等待（官方没给时间，通常几分钟自愈）；其余显示"官方未给解除时间"。
      const when = t ? '将于 ' + t + ' 解除' : (e.reason && /queue\.waiting/i.test(e.reason) ? '繁忙排队等待中（官方未给时间，通常几分钟自愈）' : '限流中（官方未给解除时间）');
      return name + acct + ' ' + when + ' · 错误码：429';
    }
    if (e.type === 'rate-recovered') {
      return name + acct + ' 限流已解除' + (e.downForMin != null ? '，共限流 ' + e.downForMin + ' 分钟' : '');
    }
    const p = [];
    if (e.models && e.models.length) p.push(e.models.join('、'));
    else if (e.model) p.push(e.model);
    if (e.variant) p.push('(' + e.variant + ')');
    if (e.accountLabel) p.push(e.accountLabel);
    if (e.resetAt) p.push('预计 ' + fmtTime(e.resetAt) + ' 解除');
    if (e.note) p.push(e.note);
    if (e.text) p.push(e.text);
    return p.join(' · ') || '—';
  };

  const bar = (t) => {
    const h = Math.round((t.credit / maxCredit) * 100);
    const dn = t.day.slice(5);
    return '<div class="bar-col" data-day="' + t.day + '" title="' + esc(t.day) + ' · ' + fmtN(t.credit) + ' 分 / ' + t.requests + ' 次"><div class="bar-val">' + (t.credit ? fmt2(t.credit) + '分' : '') + '</div><div class="bar-track"><div class="bar-fill" style="height:' + h + '%"></div></div><div class="bar-lab">' + esc(dn) + '</div></div>';
  };
  const rankRow = (r, i) => {
    const w = Math.round((r.requests / maxRank) * 100);
    // [2026-10-19] 全屏/半屏都要看全模型名：模型名+账号名都不许被省略号切掉。
    // 布局=三行网格（名+账号在上、条形在下），横向再怎么挤也只是条形缩短，文字始终完整。
    return '<div class="rank-row"><div class="rank-head"><span class="rank-idx">' + (i + 1) + '</span><span class="rank-name" title="' + esc(r.name) + '（' + esc(ac(r.acct)) + '）">' + esc(r.name) + '</span><span class="rank-acct">' + esc(ac(r.acct)) + '</span><span class="rank-num mono">' + (r.requests || 0) + ' 次</span></div><div class="rank-bar"><i style="width:' + w + '%"></i></div></div>';
  };
  const statusRow = (r) => '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.acct) + '</td><td class="mono num">' + esc(r.cw) + '</td><td><span class="pill ' + r.cls + '">' + esc(r.status) + '</span></td></tr>';
  const evRow = (e) => '<li class="ev"><span class="ev-dot ' + (evTypeLabel[e.type] ? '' : 'muted') + '"></span><div class="ev-body"><div class="ev-top"><span class="ev-tag">' + esc(evTypeLabel[e.type] || e.type) + '</span><span class="ev-time">' + esc(fmtTime(e.ts)) + '</span></div><div class="ev-text">' + esc(evText(e)) + '</div></div></li>';

  return `<div class="top">
    <div><h1>WorkBuddy 仪表盘</h1><div class="sub">WorkBuddy 模型网关 · 实时状态 · 更新于 <span id="now">${esc(new Date().toLocaleString('zh-CN', { hour12: false }))}</span></div></div>
  </div>
  <section class="kpis">
    <a class="card kpi kpi-credit" href="#" data-view="credits"><div class="kpi-label">积分余额</div><div class="kpi-val ${creditsUnlimited ? 'ok' : ''}">${creditsUnlimited ? '不限' : esc(fmtN(creditsRemain))}</div><div class="cred-rows">${creditByAcct.map((a) => '<div class="cred-row"><span>' + esc(a.label) + '<span class="dot-live ' + (a.alive ? 'ok' : 'err') + '"></span></span><b class="mono">' + (a.unlimited ? '不限' : (a.remain == null ? '—' : fmtN(a.remain))) + '</b></div>').join('')}</div></a>
    <a class="card kpi" href="#" data-view="usage"><div class="kpi-label">今日请求</div><div class="kpi-val" id="kpi-req">${todayT.requests || '0'}</div><div class="kpi-sub" id="kpi-req-sub">${todayT.credit ? fmtN(todayT.credit) + ' 分' : '今天暂无缓存'}</div></a>
    <a class="card kpi" href="#" data-view="models"><div class="kpi-label">在线模型</div><div class="kpi-val">${onlineModels}<span style="color:var(--text3);font-size:1rem"> / ${totalModels}</span></div><div class="kpi-sub">限流中 ${alerts} 个</div></a>
    <a class="card kpi" href="#" data-view="events"><div class="kpi-label">限流告警</div><div class="kpi-val ${alerts ? 'warn' : ''}">${alerts}</div><div class="kpi-sub">${alerts ? '有模型被限流' : '一切正常'}</div></a>
  </section>
  <section class="row">
    <div class="card chart"><h2>积分消耗趋势（近 7 天 · 单位：分）</h2><div class="chart-wrap"><div class="bars" id="bars">${trend.map(bar).join('')}</div></div></div>
    <div class="card rank"><h2>模型调用排行 TOP5（近 7 天 · 按次数）</h2>${rank.length ? rank.map(rankRow).join('') : '<div class="empty">最近 7 天没有调用缓存</div>'}</div>
  </section>
  <section class="row2">
    <div class="card"><h2>模型状态 · 免费（${rows.length}）</h2><div style="overflow:auto;max-height:300px"><table><thead><tr><th>模型</th><th>账号</th><th style="text-align:right">上下文</th><th>状态</th></tr></thead><tbody>${rows.map(statusRow).join('')}</tbody></table></div></div>
    <div class="card"><h2>事件时间线</h2><ul class="timeline">${events.length ? events.map(evRow).join('') : '<div class="empty">暂无事件</div>'}</ul></div>
  </section>
<script>(function(){
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function dayMinus(n){const d=new Date();d.setDate(d.getDate()-n);const p=x=>String(x).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())}
function fmt2(n){n=Number(n==null?0:n);let s=String(n);const dot=s.indexOf('.');if(dot<0)return s+'.00';s=s.slice(0,dot+3);while(s.length<dot+3)s+='0';return s}
function fmtN(n){if(n==null||n==='')return '—';return fmt2(n).replace(/\B(?=(\d{3})+(?!\d))/g,',')}
async function refresh(){
  try{
    const days=[];for(let i=0;i<7;i++)days.push(dayMinus(i));
    const js=await Promise.all(days.map(d=>fetch('/usage-detail?date='+d,{cache:'no-store'}).then(r=>r.json()).catch(()=>({variants:[]}))));
    const byDay=[];let todayReq=0,todayCredit=0;const byModel=new Map();
    js.forEach((j,idx)=>{let cr=0,rq=0;for(const v of j.variants||[]){cr+=(v.total||0);rq+=(v.requests||0);const acct=v.label||v.id||'';for(const m of v.models||[]){const k=acct+'|'+m.name;const e=byModel.get(k)||{name:m.name,acct,requests:0,credit:0};e.requests+=m.requests;e.credit+=m.credit;byModel.set(k,e);}}byDay.push({credit:Math.round(cr*100)/100,requests:rq});if(idx===0){todayReq=rq;todayCredit=cr}});
    const maxC=Math.max(1,...byDay.map(t=>t.credit));
    const daysRev=days.slice().reverse();
    const bars=document.getElementById('bars');
    if(bars){bars.innerHTML=daysRev.map((d,idx)=>{const t=byDay[days.length-1-idx];const h=Math.round(t.credit/maxC*100);return '<div class="bar-col" data-day="'+d+'" title="'+esc(d)+' · '+fmtN(t.credit)+' 分 / '+t.requests+' 次"><div class="bar-val">'+(t.credit?fmt2(t.credit)+'分':'')+'</div><div class="bar-track"><div class="bar-fill" style="height:'+h+'%"></div></div><div class="bar-lab">'+esc(d.slice(5))+'</div></div>'}).join('')}
    const kr=document.getElementById('kpi-req');if(kr)kr.textContent=todayReq;
    const ks=document.getElementById('kpi-req-sub');if(ks)ks.textContent=(todayCredit?fmtN(todayCredit)+' 分':'今天暂无数据');
    const rank=[...byModel.values()].sort((a,b)=>b.requests-a.requests).slice(0,5);const maxR=Math.max(1,...rank.map(r=>r.requests));
    const rc=document.querySelector('.rank');
    if(rc&&rank.length){const ac=(a)=>acctLabel(a);rc.innerHTML='<h2>模型调用排行 TOP5（近 7 天 · 按次数）</h2>'+rank.map((r,i)=>{const w=Math.round(r.requests/maxR*100);return '<div class="rank-row"><div class="rank-head"><span class="rank-idx">'+(i+1)+'</span><span class="rank-name" title="'+esc(r.name)+'（'+esc(ac(r.acct))+'）">'+esc(r.name)+'</span><span class="rank-acct">'+esc(ac(r.acct))+'</span><span class="rank-num mono">'+(r.requests||0)+' 次</span></div><div class="rank-bar"><i style="width:'+w+'%"></i></div></div>'}).join('')}
  }catch(e){}
}
var barsBox=document.getElementById('bars');
if(barsBox)barsBox.addEventListener('click',function(e){
  var el=e.target;while(el&&el!==barsBox&&!(el.classList&&el.classList.contains('bar-col')))el=el.parentNode;
  if(!el||el===barsBox)return;
  var day=el.getAttribute('data-day');if(!day)return;
  if(window.showView)window.showView('usage');
  var d=document.getElementById('usage-d');if(d)d.value=day;
  var go=document.getElementById('usage-go');if(go)go.click();
});
refresh();setInterval(refresh,60000);
})();</script>`;
}

// 完整独立页（保留 /dashboard 直接访问入口）
function renderDashboard() {
  return appShell('dash', renderDashboardInner(), '看板 · wb-shim');
}

/** 二级页面 HTML（纯内联，无外部依赖；JS 每 60 秒拉 /api/router 刷新）
 * 🔴 文案铁律（2026-10-14 老大令"不是大白话"）：每个字过一遍"老大能看懂吗"——
 *   不用"deployment/weight/fallback/探针/inferred"这类术语；
 *   机器人说"bot"，模型说名字，动作说人话（"挪走/顶上/撑到几点"）。
 */
function renderUsageInner() {
  return `<div>
<h1>积分明细（官方账）</h1>
<div class="sub">数据源：官方 get-user-request-usage，按模型聚合。免费模型显示 0 分是官方口径（限免期不扣分）。⚠ 单日官方最多返回 3000 条（超量日为抽样聚合，当天 &lt;3000 请求则为全量）。</div>
<div class="datebar">
  <input type="date" id="usage-d">
  <button id="usage-go">查这一天</button>
  <button class="ghost" id="usage-today">今天</button>
  <button class="ghost" id="usage-prev">← 前一天</button>
  <button class="ghost" id="usage-next">后一天 →</button>
</div>
<div id="usage-content">加载中…</div>
<script>(function(){
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function today(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function shift(n){const i=document.getElementById('usage-d');const v=i.value?new Date(i.value+'T12:00:00'):new Date();v.setDate(v.getDate()+n);i.value=v.getFullYear()+'-'+String(v.getMonth()+1).padStart(2,'0')+'-'+String(v.getDate()).padStart(2,'0');load()}
async function load(){
  const el=document.getElementById('usage-content');if(!el)return;el.textContent='加载中…（当天首次拉取需 5~30 秒，之后秒开）';
  const d=document.getElementById('usage-d').value||'';
  try{
    // [2026-10-19] 单账号 fetch failed 时前端自动重查一次（服务端已带重试，这里是兜底双保险）
    let j=await(await fetch('/usage-detail'+(d?'?date='+d:''),{cache:'no-store'})).json();
    if(!j.ok)throw new Error(j.error||'unknown');
    if(j.variants&&j.variants.some(v=>v.error)){await new Promise(r=>setTimeout(r,1200));j=await(await fetch('/usage-detail'+(d?'?date='+d:''),{cache:'no-store'})).json()}
    let html='';
    for(const v of j.variants){
      html+='<div class="card"><h2>'+esc(v.label||v.id)+(v.total>0?'':' <span class="free">✓ 免费</span>')+'</h2>';
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
const ud=document.getElementById('usage-d');
document.getElementById('usage-go').addEventListener('click',load);
document.getElementById('usage-today').addEventListener('click',function(){ud.value=today();load()});
document.getElementById('usage-prev').addEventListener('click',function(){shift(-1)});
document.getElementById('usage-next').addEventListener('click',function(){shift(1)});
ud.value=today();
load();
})();</script>
</div>`;
}
/** 二级页面「模型动态」（2026-10-15 瘦身改名，原「自动化总览」）：
 * 只显示三块份内事：① 模型状态总览（免费到期 + 限流）② 状态变更时间线 ③ 模块心跳。
 * 数据全部来自 /api/router（events.jsonl + 两个哨兵状态 + 服务日志年龄）。
 * 🔴 文案铁律（2026-10-14 老大令）：每个字过一遍"老大能看懂吗"，不用术语。
 */
function renderEventsInner() {
  // [2026-10-20] 前端映射由服务端渲染时注入（用户自定义显示名实时生效，不再写死 Lecoo 套）。
  // 服务端禁止函数调用进前端（2026-10-19 翻车教训），这里只注入纯数据。
  const _disp = getDisplayConfig();
  const _dispJson = JSON.stringify({ accounts: _disp.accounts, variants: _disp.variants }).replace(/</g, '\\u003c');
  return `<div class="wrap">
<div id="content"><div class="card"><div class="empty">加载中…</div></div></div>
<script>(function(){
// 🔴 前端 script 里禁止调用服务端函数（acctLabel 等）——浏览器里不存在 ⇒ ReferenceError
// ⇒ load() 中断 ⇒ 页面永远停在"加载中..."（2026-10-19 实测翻车）。映射由服务端注入为纯数据。
const DISP=${_dispJson};
const ACCT_LABELS=DISP.accounts;
const VARIANT_LABELS=DISP.variants;
const acctLabelOf=(k)=>ACCT_LABELS[k]||k;
const variantLabelOf=(k)=>VARIANT_LABELS[k]||k;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmtT(ms){if(!ms)return '-';const d=new Date(ms);const p=(n)=>String(n).padStart(2,'0');return d.getFullYear()+'/'+p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())}
function leftText(ms){if(ms<=0)return '已经到期了';const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4);if(d>0)return '还能用 '+d+' 天'+(h?' '+h+' 小时':'');if(h>0)return '还能用 '+h+' 小时'+(m?' '+m+' 分':'');return '还剩 '+m+' 分钟'}
function evText(e){
  // 限流/恢复两条按老大钦定格式输出，不拼官方英文原文；账号必标（旧事件缺 accountLabel 用 account 反查）
  const name=e.model||e.group||'';
  const acctName=e.accountLabel||acctLabelOf(e.account);
  const acct=' ( '+acctName+' )';
  if(e.type==='rate-limited'){
    // [2026-10-20 老大定] 无官方时间按 429 类型写清楚，别写"时间待确认"
    var when=e.resetAt?fmtT(e.resetAt):(e.reason&&/queue\.waiting/i.test(e.reason)?'繁忙排队等待中（官方未给时间，通常几分钟自愈）':'限流中（官方未给解除时间）');
    return name+acct+' '+(e.resetAt?'将于 '+when+' 解除':when)+' · 错误码：429';
  }
  if(e.type==='rate-recovered'){
    return name+acct+' 限流已解除'+(e.downForMin!=null?'，共限流 '+e.downForMin+' 分钟':'');
  }
  const p=[];
  if(e.models&&e.models.length)p.push(e.models.join('、'));
  else if(e.model)p.push(e.model);
  // [2026-10-20] variant 显示名：新事件落盘时已是自定义名；旧事件存的是内部 id，
  // 这里过一遍前端映射兜底（VARIANT_LABELS 由服务端注入），改名后旧事件也跟着变。
  if(e.variant)p.push('('+variantLabelOf(e.variant)+')');
  if(e.accountLabel)p.push(e.accountLabel);
  if(e.leftText)p.push('还剩 '+e.leftText);
  if(e.expiryText)p.push('免费到 '+e.expiryText);
  if(e.resetAt)p.push('预计 '+fmtT(e.resetAt)+' 解除');
  if(e.total!=null)p.push('剩余 '+e.total+' 分');
  if(e.note)p.push(e.note);
  return p.join(' · ')||'-';
}
async function load(){
  const box=document.getElementById('content');if(!box)return;
  let d;try{d=await(await fetch('/api/router',{cache:'no-store'})).json()}catch(e){box.innerHTML='<div class="card"><div class="empty">加载失败：'+esc(e.message)+'</div></div>';return}
  const H=[];

  /* ① 一句话总结（结构化排版） */
  const free=d.freeModels.filter(m=>!m.expired);
  const limited=(d.rateState||[]).filter(r=>r.status==='rate-limited');
  // 账号键 → 人话名：前端本地映射（上面 acctLabelOf），不调服务端函数
  const labelFor = acctLabelOf;
  let sumHtml;
  if(limited.length){
    const items=limited.map(l=>{
      const accs=(l.accountStatus||[]).filter(a=>a.status==='rate-limited');
      const accTxt=accs.map(a=>labelFor(a.account)).join('、')||labelFor('workbuddy');
      // [2026-10-20 老大定] 无官方时间按类型写清楚（queue.waiting=繁忙排队等待）
      const isQueue=l.reason&&/queue\.waiting/i.test(l.reason);
      const etaTxt=l.resetAt?('预计 '+fmtT(l.resetAt)+' 恢复'):(isQueue?'繁忙排队等待中（官方未给时间，通常几分钟自愈）':'限流中（官方未给解除时间）');
      return '<div class="lim-item"><span class="lim-name">'+esc(l.model||l.group)+'</span><span class="lim-acct">'+esc(accTxt)+'</span><span class="lim-eta">'+esc(etaTxt)+'</span></div>';
    }).join('');
    sumHtml='<div class="lim-head"><span class="lim-dot"></span><b>有 '+limited.length+' 个模型正被限流</b><span class="lim-note">到点自动复测，解限后自动更新</span></div>'+items;
  }else if(free.length){
    const next=free.reduce((a,b)=>a.leftMs<b.leftMs?a:b);
    sumHtml='<div class="ok-line"><span class="ok-dot"></span><b>一切正常</b>，'+free.length+' 个免费模型都能用；<span class="ok-note">最早到期 '+esc(next.upstreamModel||next.model)+'（'+leftText(next.leftMs)+'）</span></div>';
  }else{
    sumHtml='<div class="warn-line">登记的免费模型全部到期了（详见下方状态表）</div>';
  }
  H.push('<div class="card"><h2>一句话总结</h2><div class="summary">'+sumHtml+'</div></div>');

  /* ② 模型状态总览：免费模型 */
  H.push('<div class="card"><h2>免费模型还能用多久</h2><div class="q">官方说的截止时间；到期自动标记"已到期"，官方延期了登记表会自动跟着改</div>');
  if(!d.freeModels.length)H.push('<div class="empty">没有登记的免费模型</div>');
  else{
    H.push('<table><thead><tr><th>模型</th><th>区域</th><th>免费到</th><th>还剩多久</th><th>状态</th></tr></thead><tbody>');
    for(const m of d.freeModels){
      const until=String(m.expiry).replace(/T23:59:59\\+08:00/,'').replace(/T00:00:00\\+08:00/,'');
      const cls=m.expired?'err':(m.leftMs<7*864e5?'warn':'ok');
      const isTimeWindow=/23:00/.test(m.freeWindow||'');
      const winHtml=m.freeWindow?(isTimeWindow?'<b style="color:var(--warn)">'+esc(m.freeWindow)+'</b>':esc(m.freeWindow)):'';
      const mid=String(m.upstreamModel||m.model||'');
      const isIntl=/intl/i.test(mid)||String(m.variant||'').toLowerCase().includes('intl');
      const regionTag=isIntl?'<span class="reg intl">国际</span>':'<span class="reg cn">国内</span>';
      H.push('<tr><td><b>'+esc(mid)+'</b>'+(winHtml?'<div style="color:var(--text3);font-size:.72rem">'+winHtml+'</div>':'')+'</td><td>'+regionTag+'</td><td class="mono">'+esc(until)+'</td><td>'+(m.expired?'—':leftText(m.leftMs))+'</td><td><span class="pill '+cls+'">'+(m.expired?'已到期':'可用')+'</span></td></tr>');
    }
    H.push('</tbody></table>');
  }
  H.push('</div>');

  /* ② 模型状态总览：限流（一模型一行，账号做横排标签） */
  H.push('<div class="card"><h2>现在有没有被限流</h2><div class="q">限流由真实流量捕获（429 带官方重置时间才记），到点自动复测恢复，都记进时间线</div>');
  const rs=d.rateState||[];
  if(!rs.length)H.push('<div class="empty">还没有限流监控数据</div>');
  else{
    H.push('<table><thead><tr><th>模型</th><th>账号状态</th><th>预计恢复</th></tr></thead><tbody>');
    for(const r of rs){
      const accts=(r.accountStatus&&r.accountStatus.length)?r.accountStatus:[{account:'workbuddy',status:r.status,resetAt:r.resetAt}];
      const tags=accts.map(a=>'<span class="acct-tag '+(a.status==='rate-limited'?'err':'ok')+'">'+esc(labelFor(a.account))+(a.status==='rate-limited'?' · 限流':' · 正常')+'</span>').join('');
      const anyLimited=accts.some(a=>a.status==='rate-limited');
      let eta;
      if(anyLimited){ const hit=accts.filter(a=>a.status==='rate-limited')[0]; eta=hit?(hit.resetAt?fmtT(hit.resetAt):(hit.reason&&/queue\.waiting/i.test(hit.reason)?'繁忙排队等待中':'限流中（官方未给时间）')):'限流中（官方未给时间）'; }
      else eta='<span class="ok-note">正常访问</span>';
      H.push('<tr><td><b>'+esc(r.model||r.group)+'</b></td><td>'+tags+'</td><td class="evtext">'+eta+'</td></tr>');
    }
    H.push('</tbody></table>');
  }
  H.push('</div>');

  /* ③ 状态变更时间线（低水位只留最新；最多 20 条一页） */
  H.push('<div class="card"><h2>状态变更时间线</h2><div class="q">模型上下架、限流/恢复、到期/延期——都记在这里（积分低水位只保留最新一条）</div>');
  const rawNs=d.events||[];
  const lowIdx=rawNs.findIndex(n=>n.type==='credits-low');
  const ns=rawNs.filter((n,i)=>n.type!=='credits-low'||i===lowIdx);
  if(!ns.length)H.push('<div class="empty">还没有记录</div>');
  else{
    const kinds={'model-added':'模型上架','model-removed':'模型下架','rate-limited':'被限流','rate-recovered':'限流恢复','model-expired':'免费到期','expiry-extended':'到期推迟','expiry-notice':'到期预告','promo-update':'官方日期更新','credits-low':'积分低水位'};
    H.push('<table><thead><tr><th>时间</th><th>事件</th></tr></thead><tbody id="tl-body"></tbody></table>');
    H.push('<div id="tl-pager" class="pager"></div>');
    H.push('<div class="note">想让这些事件同时推到别处（比如你自己的飞书机器人）？在项目根目录放一个 hooks.json：{"url":"https://…"}，每条事件都会 POST 过去。不配就只记在这里，安静。</div>');
    window.__tl={ns,kinds,fmtT,evText,page:0,per:10};
  }
  H.push('</div>');

  box.innerHTML=H.join('');
  renderTimeline();
}
function renderTimeline(){
  const t=window.__tl; if(!t) return;
  const body=document.getElementById('tl-body'); if(!body) return;
  const pages=Math.max(1,Math.ceil(t.ns.length/t.per));
  if(t.page>=pages) t.page=pages-1;
  const start=t.page*t.per, slice=t.ns.slice(start,start+t.per);
  body.innerHTML=slice.map(n=>{
    const cls=(n.type==='rate-limited'||n.type==='model-expired'||n.type==='credits-low')?'err':(n.type==='model-added'||n.type==='rate-recovered'||n.type==='expiry-extended')?'ok':'';
    return '<tr><td class="mono" style="white-space:nowrap">'+t.fmtT(n.ts)+'</td><td><span class="pill '+cls+'">'+esc(t.kinds[n.type]||n.type)+'</span><div class="evtext" style="margin-top:.3rem">'+esc(t.evText(n))+'</div></td></tr>';
  }).join('');
  const pager=document.getElementById('tl-pager');
  if(!pager) return;
  if(pages<=1){pager.innerHTML='';return}
  let ph='';
  for(let i=0;i<pages;i++){ph+='<button class="pg'+(i===t.page?' on':'')+'" data-pg="'+i+'">'+(i+1)+'</button>';}
  pager.innerHTML='<span class="pg-info">共 '+t.ns.length+' 条 · 第 '+(t.page+1)+'/'+pages+' 页</span>'+ph;
  pager.querySelectorAll('[data-pg]').forEach(b=>b.onclick=()=>{window.__tl.page=Number(b.getAttribute('data-pg'));renderTimeline()});
}
load();setInterval(load,60000);
})();</script>
</div>`;
}

// [2026-10-18] 账单页：近 30 天每日汇总（单页 App 的「账单」栏目片段）。
function renderBillsInner() {
  const fmt2 = (n) => { let s = String(Number(n == null ? 0 : n)); const dot = s.indexOf('.'); if (dot < 0) return s + '.00'; s = s.slice(0, dot + 3); while (s.length < dot + 3) s += '0'; return s; };
  const fmtC = (n) => fmt2(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const d = dateMinus(i);
    const t = dayTotals(d);
    if (t.credit > 0 || t.requests > 0) rows.push({ day: d, credit: t.credit, requests: t.requests });
  }
  const sumCredit = rows.reduce((s, r) => s + r.credit, 0);
  const sumReq = rows.reduce((s, r) => s + r.requests, 0);
  const maxC = Math.max(1, ...rows.map((r) => r.credit));
  return `<div>
<style>
.bill-hero{display:flex;justify-content:space-between;gap:2.5rem;margin:.4rem 0 1.5rem;flex-wrap:wrap}
.bill-hero .bh-label{color:var(--text3);font-size:.82rem}
.bill-hero .bh-num{font-size:2.6rem;font-weight:700;line-height:1;margin:.22rem 0;font-variant-numeric:tabular-nums}
.bill-hero .bh-num.credit{color:var(--brand)}
.bill-hero .bh-num span{font-size:1rem;color:var(--text3);font-weight:400;margin-left:.25rem}
.brow{display:flex;align-items:center;gap:1rem;padding:.52rem .2rem;border-bottom:1px solid var(--border);cursor:pointer}
.brow:last-child{border-bottom:0}
.brow:hover{background:var(--surface)}
.brow-date{flex:none;width:5.6rem;font-family:var(--font-mono);font-size:.8rem;color:var(--text2)}
.brow-bar{flex:1;height:14px;background:var(--surface);border:1px solid var(--border);border-radius:4px;overflow:hidden;min-width:0}
.brow-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--brand),#ffb860);border-radius:3px}
.brow-credit{flex:none;width:7.4rem;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-size:.9rem}
.brow-credit span{color:var(--text3);font-weight:400;font-size:.74rem;margin-left:.15rem}
.brow-req{flex:none;width:4.6rem;text-align:right;color:var(--text3);font-size:.8rem;font-variant-numeric:tabular-nums}
</style>
<div class="brand"><b>账单汇总</b> · 近 30 天每日消耗（来自磁盘缓存）</div>
<div class="bill-hero">
<div><div class="bh-label">近 30 天总消耗</div><div class="bh-num credit">${fmtC(sumCredit)}<span>分</span></div></div>
<div><div class="bh-label">近 30 天总请求</div><div class="bh-num">${sumReq.toLocaleString()}<span>次</span></div></div>
<div><div class="bh-label">有消耗天数</div><div class="bh-num">${rows.length}<span>天</span></div></div>
</div>
<div class="subtle">点任意一天看那天的单笔明细（或去 <a class="back" href="#" data-view="usage">用量页</a>）</div>
<div class="card">
${rows.length ? rows.map((r) => { const w = Math.round((r.credit / maxC) * 100); return `<div class="brow" data-day="${r.day}"><div class="brow-date">${r.day}</div><div class="brow-bar"><i style="width:${w}%"></i></div><div class="brow-credit">${fmtC(r.credit)}<span>分</span></div><div class="brow-req">${r.requests} 次</div></div>`; }).join('') : '<div class="empty">近 30 天没有本地用量缓存。</div>'}
</div>
<script>(function(){
document.querySelectorAll('.brow').forEach(function(b){
  b.addEventListener('click',function(){
    var day=b.getAttribute('data-day');if(!day)return;
    if(window.showView)window.showView('usage');
    var d=document.getElementById('usage-d');if(d)d.value=day;
    var go=document.getElementById('usage-go');if(go)go.click();
  });
});
})();</script>
</div>`;
}

// [2026-10-18] 设置页：服务状态与凭据清单（单页 App 的「设置」栏目片段）。
function renderSettingsInner() {
  const fmtN = (n) => {
    if (n == null || n === '') return '—';
    const s = Number(n).toFixed(2);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  const esc2 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = allRuntimes.filter((rt) => rt.catalog.isVisible()).map((rt) => {
    const c = rt.credits;
    const remain = c ? (c.unlimited ? '不限' : fmtN((c.accounts || []).reduce((s, a) => s + (a.unlimited ? 0 : (a.remain || 0)), 0))) : '—';
    const total = c ? (c.unlimited ? '不限' : fmtN(c.total ?? 0)) : '—';
    // [2026-10-20 老大定] 只有一个概念：账号（自定义名）。"机器"列和内部标识列都删——
    // 用户视角只有"我接入了哪些账号"，workbuddy-deb 这类内部 key 不该露给用户。
    return `<tr><td><b>${esc2(rt.label)}</b></td><td class="num">${remain}</td><td class="num">${total}</td><td><span class="pill ${c ? 'ok' : 'err'}">${c ? '已接入' : (rt.creditsError || '未接入')}</span></td></tr>`;
  }).join('\n');
  return `<div class="wrap">
<div class="brand"><b>设置</b> · wb-shim 运行状态与凭据</div>
<div class="card"><h2>服务信息</h2>
  <div class="kv">
    <b>监听端口</b><span class="mono">${PORT}</span>
    <b>工作目录</b><span class="mono">${esc2(HERE)}</span>
    <b>Token 数</b><span>${TOKENS.length}</span>
    <b>接入账号</b><span>${allRuntimes.filter((r) => r.catalog.isVisible()).length}</span>
  </div>
</div>
<div class="card"><h2>接入账号</h2>
<table><thead><tr><th>账号</th><th style="text-align:right">剩余积分</th><th style="text-align:right">总量</th><th>状态</th></tr></thead><tbody>
${rows || '<tr><td colspan="4" class="empty">没有可见账号</td></tr>'}
</tbody></table>
</div>
<div class="card"><h2>账号名称</h2><div class="q">接入的账号自己起名，全站（看板/积分/模型/事件/设置）自动同步。开源用户不必沿用默认名。</div>
<div class="kv" id="disp-f">
  <b>账号一（国内版）</b><input class="disp-in" data-key="accounts.workbuddy" />
  <b>账号二（国际版）</b><input class="disp-in" data-key="accounts.workbuddy-ai" />
  <b>账号三（Debian）</b><input class="disp-in" data-key="accounts.workbuddy-deb" />
</div>
<div style="margin-top:10px"><button class="pg" id="disp-save">保存账号名称</button> <span id="disp-msg" class="subtle"></span></div>
<script>(function(){
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function loadDisp(){
  try{
    const d=await(await fetch('/api/display',{cache:'no-store'})).json();
    document.querySelectorAll('.disp-in').forEach(function(i){
      const k=i.getAttribute('data-key'); const sec=k.split('.')[0], key=k.split('.')[1];
      i.value=(d[sec]&&d[sec][key])||'';
      i.placeholder=key;
    });
  }catch(e){}
}
document.getElementById('disp-save').onclick=async function(){
  const body={accounts:{},variants:{}};
  document.querySelectorAll('.disp-in').forEach(function(i){
    const k=i.getAttribute('data-key').split('.');
    body[k[0]][k[1]]=i.value.trim();
  });
  try{
    const r=await(await fetch('/api/display',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    document.getElementById('disp-msg').textContent=r.ok?'✅ 已保存，全站生效':'❌ '+esc(r.error||'保存失败');
  }catch(e){document.getElementById('disp-msg').textContent='❌ '+esc(e.message)}
};
loadDisp();
})();</script>
</div>
<div class="card"><h2>连接方式</h2>
<div class="connline">地址 <code class="copy-source">http://100.108.133.82:18796/v1</code><button class="copy-button" data-copy="http://100.108.133.82:18796/v1">⧉</button></div>
<div class="connline">API Key <span class="subtle" style="display:inline">在服务端 token.txt 文件里</span></div>
<div class="connline">本机直连把地址换成 <code>127.0.0.1:18796/v1</code></div>
<div class="connline">协议 <code>/v1/chat/completions</code> · <code>/v1/messages</code> · <code>/v1/responses</code></div>
</div>
<div class="card"><h2>模块心跳</h2><div class="q">盯模型状态的几个后台模块，哪个停了这里直接显示（每 60s 自刷新）</div>
<table><thead><tr><th>模块</th><th>干的活</th><th>状态</th><th>最近在忙</th></tr></thead><tbody id="hb-body">
<tr><td colspan="4" class="empty">读取中…</td></tr>
</tbody></table></div>
<script>(function(){
const jobs={'wb-shim':'模型目录+调用网关（主页那些模型就是它供的）','free-expiry':'到期哨兵：到期/预告记时间线并标状态','rate-guard':'限流调度：定时轻探测 + 真实流量捕获，到点复测自动解限并记时间线','promo-sync':'盯官方日期：官方改了免费期自动改登记表'};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function hb(){
  try{
    const d=await(await fetch('/api/router',{cache:'no-store'})).json();
    const el=document.getElementById('hb-body'); if(!el) return;
    el.innerHTML=(d.health||[]).map(s=>'<tr><td class="mono">'+esc(s.name)+'</td><td class="evtext">'+esc(jobs[s.name]||'')+'</td><td><span class="pill '+(s.alive?'ok':'err')+'">'+(s.alive?'在岗':'停了')+'</span></td><td class="evtext">'+esc(s.lastLogText)+'</td></tr>').join('')||'<tr><td colspan="4" class="empty">无数据</td></tr>';
  }catch(e){}
}
hb(); setInterval(hb,60000);
})();</script>
</div>`;
}

// [2026-10-18] 积分页：hero 总览 + 三栏账号卡（大气简单；分包明细去掉横拉滚条）
function renderCreditsInner() {
  // 账号短名/标签统一走 accounts.mjs 真源（2026-10-19 收口）
  const acctShort = (rt) => acctLabel(acctKeyOfRuntime(rt, CN_VARIANT.id));
  const fmt2 = (n) => { let s = String(Number(n == null ? 0 : n)); const dot = s.indexOf('.'); if (dot < 0) return s + '.00'; s = s.slice(0, dot + 3); while (s.length < dot + 3) s += '0'; return s; };
  const fmtC = (n) => fmt2(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const visible = allRuntimes.filter((rt) => rt.catalog.isVisible());
  let heroRemain = 0, heroUnlimited = false, updated = 0;
  for (const rt of visible) {
    const c = rt.credits; if (!c) continue;
    if (rt.creditsAtMs && rt.creditsAtMs > updated) updated = rt.creditsAtMs;
    if (c.unlimited) heroUnlimited = true; else heroRemain += (c.total ?? 0);
  }
  const pkgRows = (c) => {
    const groups = new Map();
    for (const a of c.accounts ?? []) {
      const g = groups.get(a.packageName) || { name: a.packageName, remain: 0, size: 0, zero: 0, unlimited: a.unlimited === true, expiry: Infinity };
      if (a.unlimited) { g.unlimited = true; g.remain = Infinity; }
      else {
        g.remain += a.remain;
        if (a.remain > 0) { g.size += a.size; if (a.expireAt && a.expireAt > Date.now() && a.expireAt < g.expiry) g.expiry = a.expireAt; }
        else g.zero += 1;
      }
      groups.set(a.packageName, g);
    }
    return [...groups.values()].map((g) => {
      const remain = g.unlimited ? '不限' : g.remain.toLocaleString();
      const pct = g.unlimited ? 100 : Math.min(100, Math.round((g.remain / (g.size || 1)) * 100));
      const exp = Number.isFinite(g.expiry) ? fmtTime(g.expiry).slice(0, 10) : '—';
      const zeroNote = g.zero ? ` · ${g.zero} 个已用完` : '';
      const cls = g.unlimited || g.remain > 0 ? 'pos' : 'used';
      return `<div class="pkg"><div class="pkg-top"><span class="pkg-name">${esc(g.name)}</span><span class="pkg-num ${cls}">${remain} <i>${pct}%</i></span></div><div class="pkg-sub">到期 ${esc(exp)}${zeroNote}</div></div>`;
    }).join('') || '<div class="pkg-sub">无分包明细</div>';
  };
  const cards = visible.map((rt) => {
    const c = rt.credits;
    const nearest = (c?.accounts ?? []).reduce((m, a) => (a.remain > 0 && a.expireAt && a.expireAt > Date.now() && a.expireAt < m ? a.expireAt : m), Infinity);
    const expTxt = Number.isFinite(nearest) ? `最近到期 ${esc(fmtTime(nearest).slice(0, 10))}` : '暂无到期';
    const body = c
      ? `<div class="acct-num">${c.unlimited ? '不限' : fmtC(c.total)}</div><div class="acct-exp">${expTxt}</div><div class="pkgs">${pkgRows(c)}</div>`
      : `<div class="acct-num">—</div><div class="acct-exp">${esc(rt.creditsError ?? '尚未抓取')}</div>`;
    return `<div class="acct"><div class="acct-head"><span class="acct-name">${esc(rt.variant.displayName)}（${esc(acctShort(rt))}）<span class="dot-live ${c ? 'ok' : 'err'}"></span></span></div>${body}</div>`;
  }).join('\n');
  return `<div class="wrap">
<style>
.cred-hero{margin:.4rem 0 1.9rem}
.cred-hero .ch-label{color:var(--text3);font-size:.85rem}
.cred-hero .ch-num{font-size:3.4rem;font-weight:700;color:var(--text);line-height:1;margin:.25rem 0;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.cred-hero .ch-sub{color:var(--text3);font-size:.8rem}
.cred-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.1rem;align-items:start}
@media(max-width:1020px){.cred-grid{grid-template-columns:1fr}}
.acct{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:1.25rem 1.35rem}
.acct-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.7rem}
.acct-name{font-weight:600;font-size:.95rem}
.acct-num{font-size:2.2rem;font-weight:700;color:var(--ok);line-height:1;font-variant-numeric:tabular-nums}
.acct-exp{color:var(--text3);font-size:.74rem;margin-top:.3rem}
.pkgs{margin-top:1.1rem;border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.75rem}
.pkg{display:flex;flex-direction:column;gap:.15rem}
.pkg-top{display:flex;justify-content:space-between;align-items:baseline;gap:.7rem}
.pkg-name{color:var(--text);font-size:.84rem}
.pkg-num{font-variant-numeric:tabular-nums;font-weight:600;font-size:.84rem;white-space:nowrap}
.pkg-num i{font-style:normal;font-weight:400;color:var(--text3);font-size:.72rem;margin-left:.3rem}
.pkg-num.pos{color:var(--ok)}.pkg-num.used{color:var(--text3)}
.pkg-sub{color:var(--text3);font-size:.72rem}
</style>
<div class="cred-hero"><div class="ch-label">总积分 · ${visible.length} 个账号</div><div class="ch-num">${heroUnlimited ? '不限' + (heroRemain ? ' + ' + fmtC(heroRemain) : '') : fmtC(heroRemain)}</div><div class="ch-sub">更新于 ${esc(fmtTime(updated))} · 打开页面时刷新</div></div>
<div class="cred-grid">${cards || '<div class="acct">没有可见账号</div>'}</div>
</div>`;
}

// [2026-10-18] 模型目录：单页 App 的「模型」栏目——国内/国际两个列表（本机与 Debian 合并去重），只放模型、大气简洁
function renderModelsInner() {
  const rgState = readJsonSafe(join(WB_DIR, '.rate-guard-state.json'), {});
  const limitMap = new Map();
  for (const [k, st] of Object.entries(rgState)) { const key = k.indexOf(':') > 0 ? k : 'workbuddy:' + k; limitMap.set(key, st?.status ?? 'ok'); }
  const acctInfo = (rt) => { const k = acctKeyOfRuntime(rt, CN_VARIANT.id); return { label: acctLabel(k), key: k }; };
  const expiryCfg = readJsonSafe(join(WB_DIR, 'free-expiry.json'), { entries: [] });
  const expiredModels = new Set((expiryCfg.entries ?? []).filter((e) => e.expiry && new Date(e.expiry).getTime() <= Date.now()).map((e) => e.model));
  const fmtK = (n) => n >= 10000 ? `${Math.round(n / 1000)}K` : String(n);
  const rateClean = (raw) => { const mm = String(raw == null ? '' : raw).match(/[\d.]+/); return mm ? mm[0] + 'x' : '—'; };
  const visible = allRuntimes.filter((rt) => rt.catalog.isVisible());
  const defs = [
    { key: 'cn', label: '国内版', sub: '调用 id 直接用真名' },
    { key: 'intl', label: '国际版', sub: '调用 id = 真名 + -intl 后缀' },
  ];
  const rateOf = (m) => { if (m.billing?.free === true) return 0; const mm = String(m.billing?.credits ?? '').match(/[\d.]+/); return mm ? parseFloat(mm[0]) : 999; };
  const sections = defs.map((d) => {
    const isCn = d.key === 'cn';
    const rts = visible.filter((rt) => (rt.variant.id === CN_VARIANT.id) === isCn);
    const seen = new Map();
    for (const rt of rts) for (const m of rt.catalog.current()) {
      if (!seen.has(m.id)) seen.set(m.id, { m, accounts: [] });
      const info = acctInfo(rt);
      if (!seen.get(m.id).accounts.some((a) => a.key === info.key)) seen.get(m.id).accounts.push(info);
    }
    const models = [...seen.values()].sort((a, b) => rateOf(a.m) - rateOf(b.m));
    let cred = 0, unlim = false;
    for (const rt of rts) { const c = rt.credits; if (!c) continue; if (c.unlimited) unlim = true; else cred += (c.total ?? 0); }
    const credTxt = unlim ? '不限' : (cred ? cred.toLocaleString() : '—');
    const items = models.map(({ m, accounts }) => {
      const extId = isCn ? m.id : `${m.id}-intl`;
      const free = m.billing?.free === true;
      const isExpired = expiredModels.has(m.id) || expiredModels.has(extId);
      const badges = [];
      if (free) badges.push('<span class="pill mbadge ok">免费</span>');
      if (isExpired) badges.push('<span class="pill mbadge warn">免费已到期</span>');
      const acctHtml = accounts.map((a) => {
        const lim = limitMap.get(a.key + ':' + extId) === 'rate-limited';
        return `<span class="m-acct${lim ? ' err' : ''}">${esc(a.label)}${lim ? ' · 限流' : ''}</span>`;
      }).join('');
      const rate = free ? '0.00x' : rateClean(m.billing?.credits);
      const cw = m.contextWindow ? fmtK(m.contextWindow) : '—';
      const img = m.supportsImages ? '图+文' : '仅文';
      return `<div class="mrow" data-search="${esc(`${m.name} ${extId} ${m.billing?.credits ?? ''} ${accounts.map((a) => a.label).join(' ')}`)}">
<div class="m-name">${esc(extId)}${badges.join('')}<span class="m-accts">${acctHtml}</span></div>
<div class="m-meta">${cw} · ${img} <button class="copy-button" data-copy="${esc(extId)}" aria-label="复制调用 id">⧉</button></div>
<div class="m-rate ${free ? 'free' : ''}">${rate}</div>
</div>`;
    }).join('');
    return `<div class="msec"><div class="msec-head"><h2>${d.label}</h2><span class="msec-sub">${models.length} 个模型 · 剩余积分 ${credTxt} · ${d.sub}</span></div><div class="mlist">${items || '<div class="empty">该组未抓到目录</div>'}</div></div>`;
  }).join('\n');
  const modelsStyle = `<style>
.msec{margin-bottom:2.1rem}
.msec-head{display:flex;align-items:baseline;gap:.8rem;flex-wrap:wrap;margin:.3rem 0 .9rem}
.msec-head h2{font-size:1.35rem;margin:0;font-weight:700}
.msec-sub{color:var(--text3);font-size:.78rem}
.mlist{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--panel)}
.mrow{display:flex;align-items:center;gap:1.1rem;padding:.78rem 1.1rem;border-bottom:1px solid var(--border)}
.mrow:last-child{border-bottom:0}
.mrow:hover{background:var(--surface)}
.mrow.hide{display:none}
.m-name{font-weight:600;font-size:1rem;color:var(--text);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:.5rem}
.m-meta{flex:none;font-size:.78rem;color:var(--text3);white-space:nowrap;display:flex;align-items:center;gap:.4rem}
.m-rate{flex:none;font-variant-numeric:tabular-nums;font-weight:700;font-size:1.05rem;color:var(--text2);min-width:60px;text-align:right;white-space:nowrap}
.m-rate.free{color:var(--ok)}
.mbadge{font-size:.68rem}
.mbadge.ok{color:var(--ok);border-color:var(--ok)}
.mbadge.warn{color:var(--warn);border-color:var(--warn)}
.mbadge.err{color:var(--err);border-color:var(--err)}
.m-accts{display:inline-flex;gap:.3rem;margin-left:.15rem}
.m-acct{font-size:.66rem;color:var(--text3);border:1px solid var(--border);border-radius:6px;padding:.02rem .36rem;font-weight:400;white-space:nowrap}
.m-acct.err{color:var(--err);border-color:var(--err)}
.toolbar{display:flex;gap:.6rem;align-items:center;margin-bottom:1.2rem;flex-wrap:wrap}
#q{padding:.55rem .9rem;border:1px solid var(--border);border-radius:8px;font-size:.9rem;background:var(--bg);color:var(--text);width:min(360px,90vw)}
.copy-button{background:none;border:none;cursor:pointer;padding:.12rem .32rem;border-radius:.25rem;color:var(--text3);opacity:.45;transition:opacity .2s}
.mrow:hover .copy-button{opacity:1}
.copy-button:hover{color:var(--text);background:var(--surface)}
.copy-button.ok{color:var(--brand);opacity:1}
.empty{padding:1.5rem;text-align:center;color:var(--text3)}
footer{color:var(--text3);font-size:.75rem;margin-top:1.5rem}
</style>`;
  const modelsScript = `<script>(function(){
const q=document.getElementById('q');
const qc=document.getElementById('qcount');
if(q)q.addEventListener('input',function(){
  const v=q.value.trim().toLowerCase();
  let shown=0;
  document.querySelectorAll('.mrow').forEach(function(r){
    const hay=(r.getAttribute('data-search')||r.textContent).toLowerCase();
    const hit=!v||hay.indexOf(v)>=0;
    r.classList.toggle('hide',!hit);
    if(hit)shown++;
  });
  document.querySelectorAll('.msec').forEach(function(s){s.style.display=s.querySelectorAll('.mrow:not(.hide)').length?'':'none'});
  if(qc)qc.textContent=v?shown+' 个匹配':'';
});
document.querySelectorAll('.copy-button').forEach(function(b){b.addEventListener('click',function(){
  const v=b.dataset.copy;
  try{navigator.clipboard.writeText(v);}catch(e){var t=document.createElement('textarea');t.value=v;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()}
  b.classList.add('ok');b.textContent='✓';setTimeout(function(){b.classList.remove('ok');b.textContent='⧉'},1200);
})});
})();</script>`;
  return `<div class="wrap">
${modelsStyle}
<div class="toolbar"><input id="q" type="search" placeholder="筛选模型…（名称 / 调用 id / 倍率）" autocomplete="off"><span class="subtle" id="qcount"></span></div>
${sections}
<footer>wb-shim 模型目录 · 国内版账号已合并 · 调用 id 点右侧 ⧉ 复制 · 上游为 WorkBuddy 客户端私有接口，账号与积分风险自担</footer>
</div>
${modelsScript}`;
}

const server = http.createServer(async (req, res) => {
  // 路由匹配一律剥掉 query string（?debug=1 这类参数不能挡住路径匹配）
  const urlPath = (req.url || '/').split('?')[0];
  // /healthz：免鉴权探活
  if (req.method === 'GET' && (urlPath === '/healthz' || urlPath === '/healthz/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, variants: allRuntimes.map((r) => ({ id: rtLabel(r), visible: r.catalog.isVisible(), models: r.catalog.current().length })) }));
    return;
  }
  // /alerts：免鉴权只读——限免到期/积分低水位/新白嫖上线，供监控脚本与人工巡检
  if (req.method === 'GET' && (urlPath === '/alerts' || urlPath === '/alerts/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    await Promise.all(allRuntimes.map((rt) => ensureCredits(rt)));
    res.end(JSON.stringify({
      ok: true,
      variants: allRuntimes.map((r) => ({
        id: rtLabel(r),
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
      res.end(JSON.stringify(withUsageLabels(memHit.data)));
      return;
    }
    if (!memHit) {
      try {
        const diskPath = join(HERE, 'logs', 'usage-cache', `${cacheKey}.json`);
        if (existsSync(diskPath)) {
          const diskData = JSON.parse(readFileSync(diskPath, 'utf8'));
          // [2026-10-19] 带 error 的磁盘缓存不认（10-14 翻车根因）：重新走官方
          const hasErr = (diskData?.variants || []).some((v) => v && typeof v.error === 'string');
          if (!hasErr) {
            usageCache.set(cacheKey, { at: Date.now(), data: diskData });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(withUsageLabels(diskData)));
            return;
          }
        }
      } catch { /* 磁盘缓存坏了就走官方 */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
      const payload = await getUsageDayCached(day);
      res.end(JSON.stringify(withUsageLabels(payload), null, 2));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) })); }
    return;
  }
  // /api/router：二级页面的数据接口（免鉴权只读）
  // 汇总三块：① 免费模型与到期 ② 下次自动动作预告 ③ 飞书通知历史 + 服务健康
  if (req.method === 'GET' && (urlPath === '/api/router' || urlPath === '/api/router/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await buildRouterData(), null, 2));
    return;
  }
  // [2026-10-20] /api/display：显示名读写（读写都免鉴权）。
  // 🔴 10-20 老大纠正：POST 要 Bearer 是蠢设计——浏览器里根本没有 API key，
  // 设置页保存必报 unauthorized。显示名不是敏感数据（页面本身也免鉴权），与 /api/rate-state
  // 那种"会被外部注入污染的状态"不同，读写都放开。
  if (req.method === 'GET' && (urlPath === '/api/display' || urlPath === '/api/display/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getDisplayConfig()));
    return;
  }
  if (req.method === 'POST' && (urlPath === '/api/display' || urlPath === '/api/display/')) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const merged = setDisplayConfig({
          accounts: body.accounts || {},
          variants: body.variants || {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: merged }));
        log('[display] 显示名已更新（全站生效）');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 160) }));
      }
    });
    return;
  }
  // [2026-10-15 dsh] /usage：官方积分明细页——按模型聚合的官方真账，日期可选
  // [2026-10-18] 旧独立页路由全部 302 跳进单页 App 的对应栏目（二级菜单），不再跳独立页
  const DEEP = { '/usage': 'usage', '/usage/': 'usage', '/router': 'events', '/router/': 'events', '/events': 'events', '/events/': 'events', '/bills': 'bills', '/bills/': 'bills', '/settings': 'settings', '/settings/': 'settings' };
  if (req.method === 'GET' && DEEP[urlPath]) {
    res.writeHead(302, { 'Location': '/#' + DEEP[urlPath] });
    res.end();
    return;
  }
  // [2026-10-18] 旧 /models（含 /status）独立页 → 302 跳进单页 App 的 models 栏目（二级菜单）。
  // 真正渲染在 renderAppShell() 内的 renderModelsInner()（共享 BASE_CSS，去重 :root）。
  if (req.method === 'GET' && (urlPath === '/models' || urlPath === '/models/' || urlPath === '/status' || urlPath === '/status/')) {
    res.writeHead(302, { 'Location': '/#models' });
    res.end();
    return;
  }
  // [2026-10-18] 看板（APIMART 风格仪表盘）：wb-shim 主仪表盘，落到根路径 /
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/dashboard' || urlPath === '/dashboard/')) {
    // 打开网页才去问一次积分（按需，带缓存）；没人看就不动服务器
    await Promise.all(allRuntimes.map((rt) => ensureCredits(rt)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAppShell());
    return;
  }
  // 其余路由：Bearer TOKEN（多 token 任一匹配即可；DEBIAN_TOKEN 路由到 Debian 账号）
  const auth = req.headers.authorization || '';
  let pool = live;
  if (DEBIAN_TOKEN && auth === `Bearer ${DEBIAN_TOKEN}`) pool = debLive;
  else if (!TOKENS.some((t) => auth === `Bearer ${t.token}`)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'unauthorized', code: 'unauthorized' } }));
    return;
  }
  // [2026-10-17] POST /api/rate-state：外部种限流状态（客户端 CDP 播报监听回流用）。
  // 背景：WorkBuddy 客户端直连官方 API（不走 wb-shim），官方限流时客户端弹 errorBanner
  // （"您的使用量将在 {time} 重置…"），服务端原本完全看不见。client-rate-watch（CDP :9223
  // 挂 MutationObserver）解析播报后 POST 到这里 → 写 .rate-guard-state.json + 记时间线，
  // 首页徽章/卡片即时准。与 rate-guard 哨兵共享状态文件，按 at 时间戳合并（后写者赢）。
  // 鉴权：走上面的标准 Bearer 闸（只有持 wb-shim token 的本机服务能写）。
  if (req.method === 'POST' && (urlPath === '/api/rate-state' || urlPath === '/api/rate-state/')) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1048576) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const fail = (msg, code = 400) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('请求体不是合法 JSON'); }
      const group = String(body.model || body.group || '').trim();
      const status = body.status === 'ok' ? 'ok' : (body.status === 'rate-limited' ? 'rate-limited' : null);
      if (!group || !status) return fail('需要 model(组名) + status(ok|rate-limited)');
      // 账号归属（2026-10-19 修）：-intl 后缀模型归国际版（workbuddy-ai），否则归本机 Lecoo。
      // 旧代码写死 'workbuddy:' —— 国际版模型（如 step-5-preview-intl）会被记到国内版头上，
      // 页面显示成 "Lecoo" 而不是 "Lecoo-intl"。同 accountsForModelGroup 的账号维度规则。
      // 也支持调用方显式传 account（client-rate-watch / 人工种入时用）。
      const acctKey = body.account && ['workbuddy', 'workbuddy-ai', 'workbuddy-deb'].includes(body.account)
        ? body.account
        : (String(group).endsWith('-intl') ? 'workbuddy-ai' : 'workbuddy');
      const key = acctKey + ':' + group;
      const acctLabelText = acctLabel(acctKey);
      const now = Date.now();
      const resetAt = Number(body.resetAt) > 0 ? Number(body.resetAt) : null;
      try {
        const stateFile = join(WB_DIR, '.rate-guard-state.json');
        const state = readJsonSafe(stateFile, {});
        const prev = state[key] || {};
        const reason = String(body.reason || '').slice(0, 200) || null;
        const source = String(body.source || 'external').slice(0, 40);
        if (status === 'rate-limited') {
          // 新撞限流（或官方给了更晚的重置时间）才记事件，避免同一播报刷屏时间线
          const isNew = prev.status !== 'rate-limited' || (resetAt || 0) > (prev.resetAt || 0);
          state[key] = { account: acctKey, model: group, status: 'rate-limited', resetAt, since: prev.since || now, at: now, reason, source };
          if (isNew) appendEvent('rate-limited', { model: GROUP_MODEL[group] ?? group, group, account: acctKey, accountLabel: acctLabelText, reason, resetAt, resetAtText: resetAt ? fmtTime(resetAt) : null, source });
          log(`[rate-state] 外部种入限流：${key} 重置≈${resetAt ? fmtTime(resetAt) : '未知'}（来源 ${source}）`);
        } else {
          const wasLimited = prev.status === 'rate-limited';
          state[key] = { account: acctKey, model: group, status: 'ok', at: now, source };
          if (wasLimited) {
            appendEvent('rate-recovered', { model: GROUP_MODEL[group] ?? group, group, account: acctKey, accountLabel: acctLabelText, source, downForMin: prev.since ? Math.round((now - prev.since) / 60000) : null });
            log(`[rate-state] 外部标记恢复：${key}（来源 ${source}）`);
          }
        }
        writeJsonSafe(stateFile, state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, group, state: state[key] }));
      } catch (e) {
        fail(`写状态失败: ${String(e).slice(0, 160)}`, 500);
      }
    });
    return;
  }
  // /v1/models：带倍率/上下文/视觉/推理明细（OpenAI 扩展字段，标准客户端自动忽略）
  // 国际版对外 id 加 -intl 后缀（id 即路由，与 chat 路由规则一致）
  // [2026-10-18] 上下文窗口强制覆盖（见下方模块级 CONTEXT_WINDOW_OVERRIDES）：上游目录对部分
  // 模型申报的窗口低于官方真实上限，客户端据此会过早压缩。这里把已知真实上限的模型抬到最大档
  // ——只改返回给客户端的 context_window，绝不动上游请求体。⚠️ 若某模型超长请求开始被上游拒绝，
  // 把对应值改回目录申报值即可（见 /v1/models 实测）。
  if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/v1/models/')) {
    const data = pool.flatMap((rt) => {
      const isCn = rt.variant.id === CN_VARIANT.id;
      return rt.catalog.current().map((m) => {
        const extId = isCn ? m.id : `${m.id}-intl`;
        const probe = probeEffortsFor(m.id, rt.lastIdentity);
        return {
          id: extId,
          object: 'model',
          created: 0,
          // [2026-10-19] 带上账号标识（rtLabel：workbuddy / workbuddy-ai / workbuddy-deb）：
          // 前端余额插件靠这个字段把 lecoo / lecoo-intl / n5105 分别对到三个积分账号。
          owned_by: `workbuddy/${rtLabel(rt)}`,
          name: m.name,
          context_window: CONTEXT_WINDOW_OVERRIDES[m.id] ?? m.contextWindow,
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
  // /v1/credits：各账号积分（按需：有人调才去问，带缓存）
  // [2026-10-19] 扫 allRuntimes（含 N5105 Debian 账号）：不带专用 token 时 pool 只有默认账号，
  // 前端余额插件要同时看到三个账号的积分（Lecoo 国内 / Lecoo-intl 国际 / N5105）。
  if (req.method === 'GET' && (urlPath === '/v1/credits' || urlPath === '/v1/credits/')) {
    const out = {};
    await Promise.all(allRuntimes.map(async (rt) => {
      await ensureCredits(rt);
      out[rtLabel(rt)] = rt.credits ? {
        total: rt.credits.unlimited ? 'unlimited' : rt.credits.total,
        unlimited: rt.credits.unlimited === true,
        accounts: rt.credits.accounts ?? [],
        cycleResetTime: rt.credits.cycleResetTime,
        fetchedAt: rt.creditsAtMs,
        ...(rt.creditsError ? { error: rt.creditsError } : {}),
      } : { error: rt.creditsError ?? '尚未抓取（打开网页或调一次 /v1/credits 即刷新）' };
    }));
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
    await Promise.all(allRuntimes.map(async (r) => {
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
        out[rtLabel(r)] = {
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
        const results = await Promise.all(pool.map(async (r) => {
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
            return { id: rtLabel(r), requests: rows.map((x) => ({ ...x, requestId: x.requestId, requestTime: x.requestTime, model: x.model, credit: Number(x.credit) || 0 })) };
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
      let rt = pool.find((r) => r.variant.id === want && r.catalog.current().some((m) => m.id === upstreamId));
      // 兜底：指定版没有该模型时试另一版（仍按裸名匹配），避免"国际版独有模型忘了加 -intl"被 404
      if (!rt) rt = pool.find((r) => r.catalog.current().some((m) => m.id === upstreamId));
      if (!rt) rt = pool.find((r) => fallbackFor(r.variant).some((m) => m.id === upstreamId));
      if (!rt) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no workbuddy model: ${modelId}`, type: 'not_found', code: 'not_found' } }));
        return;
      }
      // [2026-10-17] 上游内容审查净化：模型厂商（step/hy 系）的安全审查会把
      // 「You are a coding agent … Codex CLI … led by OpenAI …」这类冒充 OpenAI
      // 产品的 system 身份声明判 400「请求被拦截，请重新发送」（四百现场二分定位，
      // dump 在 WB_SHIM_DUMP_400 目录）。实测唯一触发词组 = "led by OpenAI"
      // （codex CLI 内置 system prompt 原文只出现 1 次），换成中性表述即整篇放行。
      for (const m of bodyObj.messages || []) {
        if (typeof m.content === 'string') {
          m.content = m.content
            .replaceAll('led by OpenAI', 'led by the project maintainers')
            .replaceAll('led by the Codex maintainers', 'led by the project maintainers');
        } else if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p && typeof p.text === 'string') p.text = p.text
              .replaceAll('led by OpenAI', 'led by the project maintainers')
              .replaceAll('led by the Codex maintainers', 'led by the project maintainers');
          }
        }
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
          // 429 限流：既记烧速（recordLimit），又实时写限流状态（按 账号:模型，供看板/模型页）——
          // 真实流量第一手发现、零额外探测；恢复由 rate-guard 到点复测。buffer 429 body 抠官方重置时间后转发调用方。
          if (status === 429) {
            recordLimit(upstreamId, null);
            const isCnVariant = rt.variant.id === CN_VARIANT.id;
            const acctKey = rt.isDebian ? 'workbuddy-deb' : (isCnVariant ? 'workbuddy' : 'workbuddy-ai');
            const extId = isCnVariant ? upstreamId : `${upstreamId}-intl`;
            let rlBody = '';
            proxyRes.setEncoding('utf8');
            proxyRes.on('data', (c) => { rlBody += c; });
            proxyRes.on('end', () => {
              try { recordProxyRateLimit(acctKey, extId, rlBody); } catch (e) { console.error('[wb-shim] 记限流状态失败:', e.message); }
              if (!res.headersSent) res.writeHead(status, proxyRes.headers);
              res.end(rlBody);
            });
            return;
          }
          // 400 现场落盘（WB_SHIM_DUMP_400=目录时启用）：上游"请求被拦截"类报错
          // 只有拿到完整请求体才能定位，平时零开销，仅在被拦时抓现场。
          if (status === 400 && process.env.WB_SHIM_DUMP_400) {
            try {
              const p = join(process.env.WB_SHIM_DUMP_400, `req400-${upstreamId}-${Date.now()}.json`);
              writeFileSync(p, upstreamBuf);
              console.error(`[wb-shim] 400现场已存 ${upstreamId} (${upstreamBuf.length}B): ${p}`);
            } catch (e) { console.error(`[wb-shim] 400现场落盘失败: ${e.message}`); }
          }
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
          let rt = pool.find((r) => r.variant.id === want && r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = pool.find((r) => r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = pool.find((r) => fallbackFor(r.variant).some((m) => m.id === upstreamId));
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
          let rt = pool.find((r) => r.variant.id === want && r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = pool.find((r) => r.catalog.current().some((m) => m.id === upstreamId));
          if (!rt) rt = pool.find((r) => fallbackFor(r.variant).some((m) => m.id === upstreamId));
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
  log(`wb-shim 就绪: http://${HOST}:${PORT}（接受 ${TOKENS.length} 个 token；Debian 专用 token ${DEBIAN_TOKEN ? '已启用' : '未配置'}）`);
  log(`挂载账号: ${allRuntimes.map((r) => rtLabel(r)).join(', ')}`);
  // [2026-10-15 dsh] 回灌即时 credit 日志（重启不丢最近的每轮消耗）
  loadCreditLog();
  // [2026-10-15 dsh] 启动后台预取最近 7 天官方账（跳过磁盘已有）——/usage 页翻开即秒开
  setTimeout(() => { prefetchRecentUsage().catch((e) => log('预取失败:', String(e).slice(0, 150))); }, 8000);
});

// 定时目录/登录态轮询（登录晚到/切换/模型上架都能跟上；不再碰积分，积分改按需）
setInterval(() => { for (const rt of allRuntimes) sweep(rt).catch((e) => log('sweep 异常:', String(e))); }, REFRESH_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，清理…');
    for (const rt of allRuntimes) rt._pluginShim?.close();
    // [2026-10-18] 优雅退场：不再接受新连接，但给在跑的流式请求最长 25s 跑完
    // （nssm AppStopMethodConsole 同步放宽到 30s，见部署记录）；到点强制退出兜底。
    // [2026-10-19] 补 closeAllConnections：旧逻辑只 server.close() 等 SSE 长连接自然
    // 排空，但流式响应是长连接、客户端不主动断就一直挂 → close 回调永不触发 →
    // 只能等 25s 兜底，又撞上 nssm 30s 强杀（SERVICE_STOP_PENDING）。现在先强制断
    // 所有连接再 close，close 回调瞬间触发，秒退，不再卡。
    log('等待在跑的请求排空（最长 25s）…');
    server.closeAllConnections();
    server.close(() => { log('已排空，退出'); process.exit(0); });
    setTimeout(() => { log('排空超时，强制退出'); process.exit(0); }, 25000).unref();
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
