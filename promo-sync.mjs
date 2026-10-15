#!/usr/bin/env node
/**
 * promo-sync.mjs —— 官方促销/限免信息自动同步（2026-10-14 补"官方延期读不到"缺口）
 *
 * 背景：老大指出的缺口——官方会延期（hy3/hy4 从 10-25 延到 10-31），
 * 但到期日只写在客户端界面里，API 不返回，靠人翻页面登记就会滞后。
 *
 * 解法：WorkBuddy 客户端会把官方产品配置缓存到本地（Electron 自动拉取），
 * 里面 data.modelPromotions 数组带**权威到期时间**（validUntil，精确到秒）：
 *   C:\Users\oadan\.workbuddy\storage\user-*\scoped\*\wb-product-config.json
 * 本脚本定期读它 → 与 free-expiry.json 登记表比对 → 有变化就自动更新 + 私聊老大。
 *
 * 🔴 关键语义：validUntil 是"次日 00:00"（如 10-26T00:00 表示免费到 10-25 结束），
 *   所以 deadline = validUntil - 1 秒，展示为"10-25 23:59"。
 *
 * 运行：nssm 服务 promo-sync（与 free-expiry 分开；它只读快照+改登记表，不动 litellm）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordNotify } from './notify-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, 'free-expiry.json');
const STATE_FILE = process.env.PROMO_STATE || join(HERE, '.promo-sync-state.json');
const SYNC_MS = Number(process.env.PROMO_SYNC_MS || 30 * 60 * 1000); // 30 分钟一轮
const DRY_RUN = process.env.PROMO_DRY_RUN === '1';

const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
const AT_OPEN_ID = process.env.LARK_ALERT_AT_OPEN_ID || 'ou_888b94e17b7d3d6dcc21ddbc6b35abb4';
const WB_STORAGE = process.env.WB_STORAGE_ROOT || 'C:\\Users\\oadan\\.workbuddy\\storage';

const log = (...a) => console.log(new Date().toISOString(), '[promo-sync]', ...a);

// ── 飞书 ────────────────────────────────────────────
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
async function sendText(text, kind = 'promo-sync', meta) {
  const token = await getToken();
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: AT_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`发消息失败: ${j.code} ${j.msg}`);
  recordNotify('promo-sync', kind, text, meta);
  return j.data?.message_id;
}

// ── 找最新的 wb-product-config.json ─────────────────
function findProductConfig() {
  if (!existsSync(WB_STORAGE)) return null;
  let best = null;
  try {
    for (const user of readdirSync(WB_STORAGE)) {
      const scoped = join(WB_STORAGE, user, 'scoped');
      if (!existsSync(scoped)) continue;
      for (const hash of readdirSync(scoped)) {
        const f = join(scoped, hash, 'wb-product-config.json');
        if (!existsSync(f)) continue;
        const m = statSync(f).mtimeMs;
        if (!best || m > best.mtime) best = { file: f, mtime: m };
      }
    }
  } catch (e) { log('扫 storage 失败:', String(e).slice(0, 120)); }
  return best;
}

/** 读官方促销数据 → [{ models:[], textZh, validFrom, validUntil, daily, priority }] */
function readPromotions() {
  const hit = findProductConfig();
  if (!hit) return null;
  let snap;
  try { snap = JSON.parse(readFileSync(hit.file, 'utf8')); } catch { return null; }
  const data = snap?.['product-config-snapshot']?.data;
  if (!data) return null;
  return {
    file: hit.file,
    mtime: hit.mtime,
    savedAt: snap['product-config-snapshot'].savedAt,
    promos: (data.modelPromotions ?? []).map((p) => ({
      id: p.id,
      kind: p.kind,
      models: p.modelIds ?? [],
      text: p.hover?.textZh ?? '',
      validFrom: p.schedule?.validFrom ?? null,
      validUntil: p.schedule?.validUntil ?? null,
      daily: p.schedule?.daily ?? null,
      priority: p.priority ?? 0,
    })),
  };
}

/** 把 "10/26/2026 00:00:00" 解析成毫秒（本地时区 = Asia/Shanghai） */
function parseWbDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, mm, dd, yyyy, hh, mi, ss] = m;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)).getTime();
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/** 官方促销 → 该模型的真实截止时刻（validUntil 是次日 00:00，减 1 秒） */
function deadlineOf(promo) {
  const until = parseWbDate(promo.validUntil);
  if (until === null) return null;
  return until - 1000;
}
function fmtDeadline(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
}

// ── 同步：官方促销 → 登记表 ─────────────────────────
async function syncOnce(state) {
  const promos = readPromotions();
  if (!promos) { log('读不到 wb-product-config（客户端没运行过？），跳过'); return; }
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const changes = [];

  for (const e of reg.entries ?? []) {
    if (!e.expiry) continue; // 付费参考条跳过
    // 找匹配这个模型的促销（validUntil 有值的才算到期类）
    const match = promos.promos
      .filter((p) => p.models.includes(e.model) && p.validUntil)
      .sort((a, b) => b.priority - a.priority)[0];
    if (!match) continue;
    const dl = deadlineOf(match);
    if (dl === null) continue;
    const officialIso = fmtDeadline(dl);
    const cur = new Date(e.expiry).getTime();
    // 允许 1 分钟误差
    if (Math.abs(cur - dl) > 60_000) {
      changes.push({ model: e.model, variant: e.variant, from: e.expiry, to: officialIso,
        fromText: String(e.expiry).slice(0, 16).replace('T', ' '),
        toText: officialIso.slice(0, 16).replace('T', ' '),
        evidence: `官方促销 id=${match.id}：${match.text}（validUntil=${match.validUntil}）` });
      e.expiry = officialIso;
      e.inferred = false;
      e.evidence = `官方 wb-product-config 自动同步（${new Date().toLocaleString('zh-CN', { hour12: false })}）：${match.text}；validUntil=${match.validUntil}`;
    }
  }

  if (!changes.length) { log('官方日期与登记表一致，无需更新'); return; }

  // 写回登记表（备份）
  if (!DRY_RUN) {
    try { writeFileSync(REGISTRY + '.bak-promo-sync', JSON.stringify(reg, null, 2), 'utf8'); } catch {}
    writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), 'utf8');
  }
  log(`发现 ${changes.length} 处官方日期变化${DRY_RUN ? '（DRY RUN，未写盘）' : '，已更新登记表'}`);
  for (const c of changes) log(`  ${c.model}: ${c.fromText} → ${c.toText}`);

  const lines = ['📅 官方限免日期有更新，我已自动改好登记表：'];
  for (const c of changes) {
    lines.push(`· ${c.model}：${c.fromText} → ${c.toText}`);
    lines.push(`  官方原文：${c.evidence.split('：')[1] || c.evidence}`);
  }
  lines.push('（自动化的到期切换/预告都按新日期走，你不用管。）');
  try { await sendText(lines.join('\n'), 'promo-update', { changes }); } catch (e) { log('通知失败:', String(e).slice(0, 120)); }
}

let stopping = false, wake = null, timer = null;
async function main() {
  if (!APP_ID || !APP_SECRET) { console.error('[promo-sync] 缺 LARK 凭据，退出'); process.exit(1); }
  const p = readPromotions();
  log(`启动：每 ${SYNC_MS / 60000} 分钟同步一次官方促销信息${DRY_RUN ? '（DRY RUN）' : ''}`);
  log(p ? `当前数据源：${p.file}（${p.promos.length} 条促销）` : '⚠️ 暂未找到 wb-product-config 快照');
  const state = {};
  while (!stopping) {
    try { await syncOnce(state); } catch (e) { log('本轮异常:', String(e).slice(0, 200)); }
    await new Promise((resolve) => {
      wake = resolve;
      // 🔴 不能 unref()（2026-10-14 血泪：unref 的 timer 不阻止进程退出，事件循环一空 node 就退）
      timer = setTimeout(() => { wake = null; timer = null; resolve(); }, SYNC_MS);
    });
  }
  log('退出');
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log('收到退出信号'); stopping = true; if (timer) clearTimeout(timer); if (wake) { const w = wake; wake = null; w(); } });
}
process.on('uncaughtException', (e) => log('uncaughtException 兜底:', e?.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandledRejection 兜底:', e?.stack || String(e)));
main().catch((e) => { console.error('[promo-sync] 致命:', e); process.exit(1); });
