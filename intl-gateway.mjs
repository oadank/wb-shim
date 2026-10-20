/**
 * intl-gateway.mjs —— 国际版渠道校验通关层（2026-10-20 · dsh）
 *
 * 🔴 背景：workbuddy.ai 上游对国际版（workbuddy-ai）单独加了「渠道校验」，
 *    非官方客户端发的一律 400：
 *      {"code":11128,"msg":"request illegal",
 *       "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
 *    国内版（codebuddy.cn）同一份代码 200 通 ⇒ 纯服务端策略差异。
 *    实测触发条件与请求内容无关（单字探针也 400），UA 版本号修对也没用。
 *
 * 🔴 为什么放在 wb-shim 而不是改插件包：
 *    dsh-workbuddy-connect 是第三方 npm 包（node_modules 里），改它 = 升级即丢，
 *    且违反「第三方不改源码」铁律。本模块用包装（wrap）方式覆写国际版
 *    chatStream 的请求头，daemon.mjs 只加一行装配，升级无感。
 *
 * ■ 通关头从哪来（不是猜的）
 *    WorkBuddyAI 5.8.4 客户端 asar 内 applyGatewayHeaders 同款复刻，
 *    位置：%LOCALAPPDATA%\Programs\WorkBuddyAI\resources\app.asar idx≈88853822。
 *    客户端真实 chat 请求比插件多发：会话链路四件套 + x-codebuddy-request:1
 *    + X-Agent-Intent/Purpose + X-Private-Data + W3C trace 七件套。
 *
 * ■ 生效范围（2026-10-20 老大定案）
 *    国内外全版本都穿官方客户端网关头。理由：这套头就是官方客户端原样，
 *    穿上只会更像官方、不会更不像；官方哪天对国内版跟进风控，我们已在门内，
 *    不必临时改代码+重启（少一次改动 = 少一个风险窗口）。
 *    排障开关：WB_SHIM_GATEWAY_CN=0 → 国内版退回插件原装路径做对照；
 *              wrapIntlGatewayClient(..., { intlOnly: true }) → 只包国际版。
 *
 * ■ 维护提示
 *    上游若升级校验（比如加签名、加 device token），先扒新版客户端 asar 的
 *    applyGatewayHeaders 对比本模块的 officialGatewayHeaders，缺啥补啥。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 上游 region 判定，与插件同规则：空 domain 视为 CN。 */
function regionOf(domain) {
  const lowered = String(domain || '').trim().toLowerCase();
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global';
  return 'cn';
}

/**
 * UA 版本号解析（复刻插件 installed→saved→fallback 链路，Windows 分支补全）。
 * 插件 0.7.1 在 Windows 上直接返回 undefined 报兜底假版本，这是本次事故的
 * 根因之一；这里自己读，读不到再回落 asar，再不行用缓存值。
 * @param {'global'|'cn'} region
 * @returns {string} 形如 "5.8.4"
 */
export function appVersionFor(region) {
  // 1) 插件 saved 缓存（installed 读到过就会写这个文件）
  const cacheName = region === 'global' ? '.workbuddy-ai-version.json' : '.workbuddy-app-version.json';
  const cachePath = join(homedir(), '.dsh', cacheName);
  try {
    if (existsSync(cachePath)) {
      const v = JSON.parse(readFileSync(cachePath, 'utf8'))?.version;
      if (/^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(String(v))) return String(v);
    }
  } catch {}
  // 2) asar 内嵌 @genie/workbuddy-desktop 版本（真安装目录）
  const exeRel = region === 'global' ? 'WorkBuddyAI' : 'WorkBuddy';
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const asar = join(localAppData, 'Programs', exeRel, 'resources', 'app.asar');
    try {
      if (existsSync(asar)) {
        const m = /"name"\s*:\s*"@genie\/workbuddy-desktop"\s*,\s*"version"\s*:\s*"([^"]+)"/u.exec(readFileSync(asar, 'utf8'));
        if (m && /^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(m[1])) return m[1];
      }
    } catch {}
  }
  // 3) 兜底：编译期默认值（与插件一致，仅作最后防线）
  return region === 'global' ? '5.5.2' : '5.5.6';
}

/**
 * [2026-10-21 对账改造] 官方客户端的会话请求 id 是 **UUIDv7 的 32 位 hex**（无横线），
 * 官方账本 `get-user-request-usage` 的 requestId 原样用它当主键（样例如
 * 01a159d3831f73aba12027abaa850e9c，前 12 位 hex = 毫秒时间戳）。
 * 原来这里发的是 randomUUID()（UUIDv4 带横线）——官方照样收，但格式和官方客户端不一致，
 * 且这个 id 从来没落到我们自己的账里，导致事后只能靠"时间窗"对账（会串账）。
 * 这里改成同款 UUIDv7-32hex，并把它记进 ring，供 daemon 取用对账。
 */
export function uuidv7Hex() {
  const ts = Date.now().toString(16).padStart(12, '0').slice(-12); // 48bit 毫秒时间戳
  const rand12 = randomBytes(2).toString('hex').slice(0, 3);       // 12bit 随机
  const variant = '89ab'[randomBytes(1)[0] & 3];                    // RFC4122 variant
  const rand60 = randomBytes(8).toString('hex').slice(0, 15);       // 60bit 随机
  return `${ts}7${rand12}${variant}${rand60}`;
}

// 最近发出去的会话请求 id（daemon 拿来和官方账 join）。上限 500，够一轮对账。
// [2026-10-21 修] 光放内存不够：官方入账有 1~2 分钟延迟，等 pill 去查时 id 可能已被
// 挤出 ring 或进程重启丢了，两边永远对不上（实测：官方那两笔 0.31 在，ring 里已没有）。
// 所以每条同时**追加落盘**，查询时合并内存 + 文件。
const CONV_RING = [];
const CONV_LOG = join(homedir(), '.dsh', 'wb-shim-conv-ids.jsonl');
export function recordConvId(rec) {
  try {
    const row = { ...rec, consumed: false };
    CONV_RING.push(row);
    if (CONV_RING.length > 500) CONV_RING.splice(0, CONV_RING.length - 500);
    appendFileSync(CONV_LOG, JSON.stringify({ t: row.t, id: row.id, region: row.region, model: row.model }) + '\n');
  } catch {}
}

/**
 * [2026-10-21 对账·主动派发] daemon 在发请求前 push 一个 convId 进来，网关这次就用它。
 * 为什么不用"事后认领"：认领要在 ring 里按 model+时间猜，ring 一重启就断、并发也容易错。
 * 主动派发是 FIFO 的——daemon 发请求和网关开流在同一进程里顺序一致，
 * 天然对齐到"这一次请求"，且这个 id 会同时出现在官方账 requestId 和我们的 credit-log 里。
 */
const PENDING_CONV_IDS = [];
export function takePendingConvId() {
  try { return PENDING_CONV_IDS.shift() || ''; } catch { return ''; }
}
export function pushPendingConvId(id) {
  try {
    if (!id) return;
    PENDING_CONV_IDS.push(String(id));
    if (PENDING_CONV_IDS.length > 200) PENDING_CONV_IDS.splice(0, PENDING_CONV_IDS.length - 200);
  } catch {}
}

/**
 * daemon 在同一进程里记账时调这个：按 (model, 最近 N 秒) 找一条尚未被认领的，
 * 认领后置 consumed=true，避免同一 id 被两笔记账重复使用。
 * 说明：dsh 的调用是串行的，冲突概率极低；即使认领错也只是 id 标错，
 * **不会多算钱** —— credit 值来自那次响应本身。
 * @param {{model?:string, withinMs?:number}} q
 * @returns {string} convId，找不到返回 ''
 */
export function claimConvId(q = {}) {
  try {
    const model = String(q.model || '');
    const within = Number(q.withinMs) || 5000;
    const minT = Date.now() - within;
    // 从后往前找最新的未认领项（同一 model 优先）
    for (let i = CONV_RING.length - 1; i >= 0; i--) {
      const r = CONV_RING[i];
      if (!r || r.consumed) continue;
      if ((r.t || 0) < minT) break;
      if (model && r.model && r.model !== model) continue;
      r.consumed = true;
      return r.id;
    }
    return '';
  } catch { return ''; }
}
/**
 * [2026-10-21 修] 查 convId 时**合并内存 ring + 落盘文件**。
 * 只读 ring 会漏：官方入账慢（1~2 分钟），等前端来取时 id 早被挤出 500 条上限，
 * 实测因此出现"官方账 0.31 在、我们这边一个 id 都对不上 ⇒ pill 显示 0"。
 * 文件按天粗略截断（保留最近约 2 万行），避免无限增长。
 */
export function knownConvIds(since = 0) {
  const out = [];
  const seen = new Set();
  for (const r of CONV_RING) {
    if ((r.t || 0) < since || seen.has(r.id)) continue;
    seen.add(r.id); out.push(r);
  }
  try {
    const lines = readFileSync(CONV_LOG, 'utf8').split('\n');
    const tail = lines.slice(-20000);
    for (const l of tail) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r || !r.id || (r.t || 0) < since || seen.has(r.id)) continue;
      seen.add(r.id); out.push({ ...r, consumed: true }); // 文件里的视为已认领
    }
  } catch { /* 还没生成过文件 */ }
  return out.sort((a, b) => (a.t || 0) - (b.t || 0));
}

/**
 * 官方客户端网关头（每次调用生成新 trace/UUID，复用同一套会被判重放）。
 * 顺序无关，键名大小写不敏感（HTTP 头规范）。
 */
export function officialGatewayHeaders(opts = {}) {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const parentSpanId = randomBytes(8).toString('hex');
  return {
    'X-Conversation-ID': randomUUID(),
    // [2026-10-21] 这个就是官方账本主键：格式对齐官方客户端（UUIDv7 32hex），可外部注入以便对账
    'X-Conversation-Request-ID': opts.conversationRequestId || uuidv7Hex(),
    'acp-connection-id': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'X-Request-ID': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-Private-Data': 'true',
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    'X-Trace-ID': traceId,
  };
}

/**
 * 包装插件 client：国际版 chatStream 走带渠道头的实现，其余方法原样透传。
 *
 * 实现方式说明：插件的 chatStream 内部自己构造 headers（chatHeaders），
 * 外部无法注入；且它的 loopback shim 会丢弃所有自定义请求头。所以这里
 * 不调它的 chatStream，而是复刻它的调用序列（同 URL /v2/chat/completions、
 * 同 body 预处理、同 fetch 参数），只把 headers 换成带网关卡头的版本。
 * CN 版仍走插件原装 chatStream，零行为变化。
 *
 * @param {object} client 插件的 WorkBuddyUpstreamClient 实例
 * @param {object} opts   { logger, intlOnly=true }
 * @returns {Proxy} 行为与原 client 一致，仅 chatStream 被覆写
 */
export function wrapIntlGatewayClient(client, opts = {}) {
  const logger = opts.logger || console;
  // [2026-10-20 老大定] 默认全版本生效。要只给国际版加（排障对照）传 intlOnly: true；
  // 全开状态下国内版可用 WB_SHIM_GATEWAY_CN=0 退回插件原装路径。
  const intlOnly = opts.intlOnly === true;

  // 复刻插件的请求体预处理（顺序必须一致，否则上游可能拒）
  const prepareBody = (bodyJson) => {
    let body;
    try { body = JSON.parse(bodyJson); } catch { return bodyJson; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return bodyJson;
    body.stream = true;
    // role:"developer" → "system"（上游不认 developer）
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (m && typeof m === 'object' && m.role === 'developer') m.role = 'system';
      }
    }
    // tool_choice:"none" → 删掉并清 tools
    if ('tool_choice' in body) {
      const c = body.tool_choice;
      const t = typeof c === 'string' ? c.trim().toLowerCase() : '';
      if (t === 'none' || (c && typeof c === 'object' && String(c.type || '').toLowerCase() === 'none')) {
        delete body.tool_choice;
        delete body.tools;
        delete body.functions;
      }
    }
    return JSON.stringify(body);
  };

  const patchedChatStream = async (credential, bodyJson, signal) => {
    // [2026-10-20 老大定] 默认全版本生效（intlOnly=false）：国内版先穿好通行证，
    // 等官方哪天跟进风控时直接豁免，不必临时改代码+重启。关掉仅用于排障对照：
    // WB_SHIM_GATEWAY_CN=0 环境下国内版退回插件原装路径。
    const cnOptOut = process.env.WB_SHIM_GATEWAY_CN === '0';
    if (intlOnly && regionOf(credential.domain) !== 'global') {
      return client.chatStream(credential, bodyJson, signal);
    }
    if (!intlOnly && cnOptOut && regionOf(credential.domain) !== 'global') {
      return client.chatStream(credential, bodyJson, signal);
    }
    const isGlobal = regionOf(credential.domain) === 'global';
    const base = isGlobal ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com';
    let body = prepareBody(bodyJson);
    // 国际版无 system 首条时补一句（插件同款：网关前置条件）
    if (isGlobal) {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.messages) && !(parsed.messages[0] && parsed.messages[0].role === 'system')) {
          parsed.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
          body = JSON.stringify(parsed);
        }
      } catch {}
    }
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: base,
      Referer: `${base}/`,
      Authorization: `Bearer ${credential.accessToken}`,
      'X-User-Id': credential.uid,
      'X-Domain': credential.domain,
      'X-Product': 'SaaS',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-Private-Data': 'true',
      // UA 版本从插件自己的缓存链路读（installed→saved→fallback），不写死：
      // 写死 = 客户端一升级就又对不上，正是本次事故的根因之一。
      'User-Agent': `WorkBuddy/${appVersionFor(regionOf(credential.domain))} ${isGlobal ? 'WorkBuddy AI' : 'WorkBuddy'}/${appVersionFor(regionOf(credential.domain))}`,
    };
    // [2026-10-21 对账改造] daemon 预先派发的 id 优先用（这样账本那行早就知道自己是谁），
    // 没有派发才自己生成。两条路都保证：官方账 requestId == 我们的 convId。
    const convId = takePendingConvId() || uuidv7Hex();
    // [2026-10-20 老大定] 通行证全版本加：国内版也一样穿官方客户端网关头。
    // 理由：这套头就是官方客户端原样，加了只会更像官方、不会更不像；
    // 官方哪天对国内版跟进风控，我们已经在门内，无需临时改动。
    Object.assign(headers, officialGatewayHeaders({ conversationRequestId: convId }));
    try {
      let bodyModel = '';
      try { bodyModel = JSON.parse(body)?.model || ''; } catch {}
      recordConvId({ t: Date.now(), id: convId, region: isGlobal ? 'global' : 'cn', model: bodyModel, uid: credential.uid || '' });
      // [2026-10-21 对账实测] 官方账本那一行的 requestId 到底取自哪个头？把这次发出的
      // 四个随机 id 全打出来，拿官方明细逐一对号——别再靠猜。
      logger.error(`[ConvId] ${convId} region=${isGlobal ? 'global' : 'cn'} model=${bodyModel} hdrs=${JSON.stringify({
        'X-Conversation-Request-ID': headers['X-Conversation-Request-ID'],
        'X-Conversation-ID': headers['X-Conversation-ID'],
        'X-Request-ID': headers['X-Request-ID'],
        'acp-connection-id': headers['acp-connection-id'],
        'X-Conversation-Message-ID': headers['X-Conversation-Message-ID'],
      })}`);
    } catch {}
    try {
      const response = await fetch(`${base}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.ok) return { ok: true, response };
      const text = (await response.text()).slice(0, 400);
      const kind = response.status === 429 ? 'soft_rate'
        : response.status === 401 ? 'session_dead'
        : response.status === 402 ? 'hard_credit'
        : response.status === 404 ? 'not_found'
        : response.status >= 500 ? 'server' : 'client';
      return { ok: false, status: response.status, kind, message: text };
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` };
    }
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chatStream') return patchedChatStream;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
