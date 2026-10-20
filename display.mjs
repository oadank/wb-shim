/**
 * display.mjs —— 显示名自定义唯一真源（2026-10-20 dsh 建）
 *
 * 为什么要有这个文件：wb-shim 要开源给大家用，别人的设备/账号不叫 Lecoo/N5105。
 * 显示名必须可自定义、改一处全站生效，而不是硬编码在某台机器的代码里。
 *
 * 机制：
 *   display.json（gitignore，每台机器自持）存用户自定义显示名，如：
 *     { "accounts": { "workbuddy": "我的主机", "workbuddy-ai": "国际版" }, "variants": {...} }
 *   读不到/字段缺 → 回落 DEFAULTS（原 Lecoo 套默认，保持兼容）。
 *   文件被外部修改 → 按 mtime 检测自动重载，不用重启服务。
 *
 * 铁律：全站显示名一律从这里取（acctLabel 已收口），禁止别处再写字面量。
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY_FILE = process.env.WB_SHIM_DISPLAY_FILE || join(HERE, 'display.json');

/** 内置默认（当前 Lecoo 套，向后兼容；用户可被 display.json 全部覆盖） */
const DEFAULTS = {
  accounts: {
    'workbuddy': 'Lecoo',
    'workbuddy-ai': 'Lecoo-intl',
    'workbuddy-deb': 'N5105',
  },
  variants: {
    'workbuddy': 'Lecoo',
    'workbuddy-ai': 'Lecoo-intl',
  },
};

let cache = { data: null, mtimeMs: 0 };

/** 读 display.json（带 mtime 缓存，文件变了自动重载） */
function load() {
  try {
    const m = statSync(DISPLAY_FILE).mtimeMs;
    if (m !== cache.mtimeMs) {
      const parsed = JSON.parse(readFileSync(DISPLAY_FILE, 'utf8'));
      cache = {
        data: {
          accounts: { ...DEFAULTS.accounts, ...(parsed.accounts || {}) },
          variants: { ...DEFAULTS.variants, ...(parsed.variants || {}) },
        },
        mtimeMs: m,
      };
    }
  } catch {
    // 文件不存在/坏 JSON → 回默认（不留死状态）
    cache = { data: { ...DEFAULTS, accounts: { ...DEFAULTS.accounts }, variants: { ...DEFAULTS.variants } }, mtimeMs: cache.mtimeMs };
    // mtimeMs 保留旧值避免反复重读坏文件；文件恢复正常后 mtime 变化会触发重载
  }
  return cache.data;
}

/** 账号键 → 自定义显示名（回落默认） */
export function acctLabel(key) {
  return load().accounts[key] || key;
}

/** variant.id → 自定义显示名（事件页/看板标题用） */
export function variantLabel(id) {
  return load().variants[id] || id;
}

/** 读当前全部显示配置（设置页展示/编辑用） */
export function getDisplayConfig() {
  return load();
}

/** 写 display.json（设置页保存用）；写完立即重载缓存 */
export function setDisplayConfig(next) {
  const merged = {
    accounts: { ...load().accounts, ...(next.accounts || {}) },
    variants: { ...load().variants, ...(next.variants || {}) },
  };
  // 只落用户实际改过的键（与默认一致的键不写，保持文件最小）
  const slim = { accounts: {}, variants: {} };
  for (const [k, v] of Object.entries(merged.accounts)) if (v !== DEFAULTS.accounts[k]) slim.accounts[k] = v;
  for (const [k, v] of Object.entries(merged.variants)) if (v !== DEFAULTS.variants[k]) slim.variants[k] = v;
  if (!Object.keys(slim.accounts).length) delete slim.accounts;
  if (!Object.keys(slim.variants).length) delete slim.variants;
  writeFileSync(DISPLAY_FILE, JSON.stringify(slim, null, 2));
  cache = { data: merged, mtimeMs: statSync(DISPLAY_FILE).mtimeMs };
  return merged;
}
