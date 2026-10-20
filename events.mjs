#!/usr/bin/env node
/**
 * events.mjs —— 模型状态时间线（wb-shim 份内自动化的唯一数据出口）
 *
 * 设计原则（老大 2026-10-15 拍板）：wb-shim 的自动化只做份内的事——
 *   维护主页模型信息显示的准确和及时。所有自动化动作（目录刷新发现模型
 *   增减、限流/解除、到期/恢复）统一在这里记一条事件，/router 页渲染
 *   时间线，首页模型列表读状态徽章。
 *
 * 通知：可选 webhook。hooks.json（gitignore）格式：
 *   { "url": "https://...", "secret": "可选" }
 * 有配置就在每条事件后 POST JSON；没配置就安静记盘，零外部依赖。
 *
 * events.jsonl：每行一条 JSON（ts/type/...）。gitignore，重启不丢。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { variantLabel } from './display.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = process.env.WB_EVENTS_FILE || join(HERE, 'events.jsonl');
const HOOKS_FILE = join(HERE, 'hooks.json');

const log = (...a) => console.log(new Date().toISOString(), '[events]', ...a);

function loadHooks() {
  try { return JSON.parse(readFileSync(HOOKS_FILE, 'utf8')); } catch { return null; }
}

/** 记一条事件。type 见下方常量；payload 自由字段（model/group/reason/resetAt...） */
export function appendEvent(type, payload = {}) {
  const ev = { ts: Date.now(), type, ...payload };
  // [2026-10-20] variant 写显示名（自定义，开源用户看到自己的名字而非内部 id）。
  // history 是快照：改名后旧事件保持当时名字，这是日志常规做法。
  if (ev.variant) { try { ev.variant = variantLabel(ev.variant); } catch { /* display.mjs 缺席时保持原值 */ } }
  try {
    // 🔴 credits-low（积分低水位）只保留最新一条（老大：历史记录不存这个）——先剔旧再写
    if (type === 'credits-low' && existsSync(EVENTS_FILE)) {
      try {
        const old = readFileSync(EVENTS_FILE, 'utf8').split('\n').filter((l) => l.trim());
        const kept = old.filter((l) => { try { return JSON.parse(l).type !== 'credits-low'; } catch { return true; } });
        writeFileSync(EVENTS_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      } catch { /* 读盘失败不阻塞本次写入 */ }
    }
    appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n', 'utf8');
  } catch (e) { log('事件写盘失败:', String(e).slice(0, 120)); }
  // 可选 webhook：不阻塞、失败只记日志（通知失败不影响主流程）
  const hooks = loadHooks();
  if (hooks?.url) {
    fetch(hooks.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(hooks.secret ? { 'X-WB-Shim-Secret': hooks.secret } : {}) },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => log('webhook 推送失败(忽略):', String(e).slice(0, 120)));
  }
  return ev;
}

/** 读最近 n 条事件（新的在前） */
export function readEvents(n = 200) {
  try {
    if (!existsSync(EVENTS_FILE)) return [];
    const lines = readFileSync(EVENTS_FILE, 'utf8').split('\n').filter((l) => l.trim());
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

/** 读探针/到期共享状态（首页徽章用） */
export function readJsonSafe(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
export function writeJsonSafe(file, obj) {
  try { writeFileSync(file, JSON.stringify(obj, null, 1)); } catch (e) { log('状态写盘失败:', String(e).slice(0, 120)); }
}
export { EVENTS_FILE };
