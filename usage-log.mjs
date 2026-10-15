/**
 * usage-log.mjs —— 模型用量与限流记账（2026-10-14）
 *
 * 干什么：官方不公开限流配额（429 响应头光秃秃，本地配置里也没有 quota 字段），
 * 所以"还能用多少就限流"算不出来。但反代能看到每次请求的 usage，自己记账：
 *   - 每个模型（上游模型名）今日的 token 消耗 + 请求数
 *   - 每个模型今日撞了几次 429、每次的解禁时间
 * 页面据此显示"今日已用 / 上次限流 / 现在被限没"，攒够历史后能算经验阈值做黄牌预警。
 *
 * 存储：logs\usage-log.json（单文件 JSON，结构 { day, models: { [id]: {tokens, requests} }, limits: { [id]: [{t, resetAt}] } }）
 *   跨天自动重置（day 字段不等于今天就清空重来）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const USAGE_FILE = join(process.env.USAGE_LOG_PATH || 'C:\\D\\opt\\wb-shim\\logs', 'usage-log.json');

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  try {
    const j = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    if (j.day !== today()) return freshDay(); // 跨天重置
    return j;
  } catch { return freshDay(); }
}
function freshDay() {
  return { day: today(), models: {}, limits: {} };
}
function save(j) {
  try { writeFileSync(USAGE_FILE, JSON.stringify(j), 'utf8'); } catch { /* 记不上不影响业务 */ }
}

/** 记一次成功调用的 token 用量（modelId = 上游模型名） */
export function recordUsage(modelId, usage) {
  if (!modelId || !usage) return;
  const j = load();
  const m = j.models[modelId] || (j.models[modelId] = { tokens: 0, requests: 0, prompt: 0, completion: 0 });
  m.tokens += usage.total_tokens || 0;
  m.prompt += usage.prompt_tokens || 0;
  m.completion += usage.completion_tokens || 0;
  m.requests += 1;
  save(j);
}

/** 记一次 429 限流（resetAt 可为 null——拿不到解禁时间就只记次数） */
export function recordLimit(modelId, resetAt) {
  if (!modelId) return;
  const j = load();
  const arr = j.limits[modelId] || (j.limits[modelId] = []);
  arr.push({ t: Date.now(), resetAt: resetAt ?? null });
  if (arr.length > 50) arr.splice(0, arr.length - 50); // 防无限增长
  save(j);
}

/** 读全量（页面用） */
export function readUsage() {
  return load();
}

/** 人话：1.23M / 45.6K */
export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n || 0);
}
