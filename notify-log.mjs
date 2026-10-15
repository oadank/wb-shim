/**
 * notify-log.mjs —— 飞书通知历史记录（2026-10-14）
 *
 * 干什么：所有服务（alert-push / free-expiry / rate-guard）发飞书前先调 record()，
 * 把"什么时候、哪个服务、什么类型、发了什么"追加到共享 JSONL 文件。
 * 看板读这个文件展示历史。
 *
 * 为什么独立文件：三个服务各有各的进程，共享一个 JSONL 追加（append 是原子的，
 * 单行不超 PIPE_BUF 不会交错）。不做数据库，避免过度设计。
 */
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_FILE = process.env.NOTIFY_LOG || 'C:\\D\\opt\\wb-shim\\logs\\notify-history.jsonl';
const MAX_LINES = 2000; // 超过就重写保留最近 1000 条，防无限增长

/**
 * 记一条通知历史。
 * @param {string} source  哪个服务发的（alert-push / free-expiry / rate-guard / daily-summary）
 * @param {string} kind    类型（free-gone / free-added / credits-low / burn-spike / retired /
 *                         rate-limit / move-back / daily-summary / timewindow / new-model / health）
 * @param {string} text    实际发出去的正文
 * @param {object} [meta]  附加信息（模型名、bot 列表、重置时间等）
 */
export function recordNotify(source, kind, text, meta) {
  const entry = {
    t: Date.now(),
    source: String(source || 'unknown'),
    kind: String(kind || 'info'),
    text: String(text || '').slice(0, 2000),
    meta: meta || undefined,
  };
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* 记不上不影响推送 */
  }
}

/** 读最近 n 条（倒序，最新在前） */
export function readNotifies(n = 100) {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    // 顺手做一次瘦身（超过上限时）
    if (lines.length > MAX_LINES) {
      const keep = lines.slice(-Math.floor(MAX_LINES / 2));
      try { writeFileSync(LOG_FILE, keep.join('\n') + '\n', 'utf8'); } catch {}
      return keep.slice(-n).map(parseLine).filter(Boolean).reverse();
    }
    return lines.slice(-n).map(parseLine).filter(Boolean).reverse();
  } catch {
    return [];
  }
}
function parseLine(l) {
  try { return JSON.parse(l); } catch { return null; }
}

export const NOTIFY_LOG_FILE = LOG_FILE;
