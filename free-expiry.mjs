#!/usr/bin/env node
/**
 * free-expiry.mjs —— 到期哨兵（2026-10-15 瘦身版）
 *
 * 职责（老大拍板：wb-shim 自动化只做份内的事）：
 *   1. 读 free-expiry.json 到期登记表，每 5 分钟算各模型剩余免费时长
 *   2. 提前预告（3 天/1 天/6 小时/最后 30 分钟各提醒一次）→ 记时间线事件
 *   3. 到期那一刻 → 记 model-expired 事件 + 状态写盘（首页模型标"已到期"）
 *
 * 已剥离（2026-10-15）：飞书私聊、改 litellm yaml 自动退役/登记新腿、
 *   fallback 链自检、每日飞书摘要——都是下游编排，不属于本独立项目。
 *   到期后模型怎么下线由使用者自己在自己的网关里处理；本服务只负责
 *   把"主页模型信息"标得准确及时。通知走 hooks.json 通用 webhook。
 *
 * 数据：free-expiry.json（到期登记表，人工维护+推断标注）
 * 运行：nssm 服务 free-expiry
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, readJsonSafe, writeJsonSafe } from './events.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'free-expiry.json');
const STATE_FILE = process.env.FREE_EXPIRY_STATE || join(HERE, '.free-expiry-state.json');
const POLL_MS = Number(process.env.FREE_EXPIRY_POLL_MS || 5 * 60 * 1000);

const log = (...a) => console.log(new Date().toISOString(), '[free-expiry]', ...a);

/** 本地（北京）日期。🔴 不能用 toISOString()——UTC 日期在北京凌晨 0-8 点会错一天 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
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

/** 提醒水位线：还剩多久时预告一次（ms）。最后 30 分钟再补一条"最后提醒" */
const STAGES = [
  { key: '3d', ms: 3 * 86400000, label: '3 天' },
  { key: '1d', ms: 1 * 86400000, label: '1 天' },
  { key: '6h', ms: 6 * 3600000, label: '6 小时' },
];

async function pollOnce(state) {
  const cfg = readJsonSafe(CONFIG, { models: [] });
  const entries = cfg.models ?? cfg.entries ?? [];
  const now = Date.now();

  for (const e of entries) {
    if (!e.expiry) continue;
    const expiry = new Date(e.expiry).getTime();
    if (!Number.isFinite(expiry)) continue;
    const left = expiry - now;
    const key = `${e.model}(${e.variant || e.variantId || 'cn'})`;
    const st = state[key] || (state[key] = {});

    // 到期
    if (left <= 0) {
      if (!st.expired) {
        st.expired = true;
        log(`${key} 已到期（${fmtDate(e.expiry)}）`);
        appendEvent('model-expired', {
          model: e.model,
          variant: e.variant || e.variantId || 'cn',
          expiry: e.expiry,
          expiryText: fmtDate(e.expiry),
          note: '免费期结束。模型仍在目录中，标记为已到期；是否下线由使用者自行处理。',
        });
      }
      continue;
    }

    // 到期后如果登记表把 expiry 改到未来（官方延期），解除"已到期"
    if (st.expired) {
      st.expired = false;
      log(`${key} 到期日被推迟到 ${fmtDate(e.expiry)}，解除已到期标记`);
      appendEvent('expiry-extended', { model: e.model, variant: e.variant || e.variantId || 'cn', expiry: e.expiry, expiryText: fmtDate(e.expiry) });
    }

    // 提前预告：每个水位只提醒一次
    for (const s of STAGES) {
      if (left <= s.ms && !st[`notified_${s.key}`]) {
        st[`notified_${s.key}`] = true;
        log(`${key} 还有 ${humanLeft(left)} 到期（${s.label} 水位预告）`);
        appendEvent('expiry-notice', {
          model: e.model,
          variant: e.variant || e.variantId || 'cn',
          leftText: humanLeft(left),
          stage: s.key,
          expiry: e.expiry,
          expiryText: fmtDate(e.expiry),
          inferred: e.inferred === true,
          note: e.inferred ? '到期日是从公告推断的，非官方接口给出，可能差一两天' : undefined,
        });
        break; // 一轮只报最高水位
      }
    }
  }
  return state;
}

async function main() {
  log(`启动：到期哨兵，每 ${POLL_MS / 1000}s 盘一次登记表（纯记录+状态标记）`);
  let state = readJsonSafe(STATE_FILE, {});
  while (true) {
    try { state = await pollOnce(state); writeJsonSafe(STATE_FILE, state); }
    catch (e) { log('本轮异常:', String(e).slice(0, 200)); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

process.on('uncaughtException', (e) => log('uncaughtException 兜底:', e?.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandledRejection 兜底:', e?.stack || String(e)));

main().catch((e) => { console.error('[free-expiry] 致命:', e); process.exit(1); });
