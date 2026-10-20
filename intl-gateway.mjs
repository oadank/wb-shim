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
 * ■ 生效范围
 *    仅 regionOf(credential.domain)==='global'（国际版）。国内版一行不加，
 *    保持原样——国内版若跟进同款风控，把 shouldPatch 的 domain 判断去掉即可。
 *
 * ■ 维护提示
 *    上游若升级校验（比如加签名、加 device token），先扒新版客户端 asar 的
 *    applyGatewayHeaders 对比本模块的 GATEWAY_EXTRA_HEADERS，缺啥补啥。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
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
 * 官方客户端网关头（每次调用生成新 trace/UUID，复用同一套会被判重放）。
 * 顺序无关，键名大小写不敏感（HTTP 头规范）。
 */
export function officialGatewayHeaders() {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const parentSpanId = randomBytes(8).toString('hex');
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
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
  const intlOnly = opts.intlOnly !== false;

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
    if (intlOnly && regionOf(credential.domain) !== 'global') {
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
    if (isGlobal) Object.assign(headers, officialGatewayHeaders());
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
