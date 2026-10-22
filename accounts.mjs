/**
 * accounts.mjs —— 账号维度唯一真源（2026-10-19 dsh 建；2026-10-20 接入自定义显示名）
 *
 * 为什么要有这个文件：wb-shim 有账号（本机 / 国际版），
 * 账号键 → 显示名的映射曾经散在 daemon.mjs 9 处 + rate-guard.mjs 1 处，各写一遍三目表达式。
 * 改一处漏八处 = 页面名字对不上（真实发生过）。现在全收口到这里，谁要显示名都 import。
 *
 * 2026-10-20 起：显示名从 ./display.mjs 取（用户可在设置页自定义，落到 display.json）。
 * 本文件管"账号维度怎么判"，display.mjs 管"叫什么名字"——两件事分开。
 *
 * 账号键（account key）是状态文件 .rate-guard-state.json 的键前缀，形如 `workbuddy-ai:模型名`：
 *   workbuddy       本机国内版（CN variant）
 *   workbuddy-ai    本机国际版（INTL variant）
 *
 * 2026-10-23：副号 workbuddy-deb（N5105/Debian）已按老大要求删除——官方封号 + 不再使用。
 * 挂载代码在 daemon.mjs 走 kill switch（DEBIAN_KILL_SWITCH 默认开）永远不会挂。
 *
 * 铁律：新增/改名只改本文件 + display.json，别处一律 import。
 */

import { acctLabel as displayName } from './display.mjs';

/** 账号键列表（按展示顺序：国内、国际） */
export const ACCOUNT_KEYS = ['workbuddy', 'workbuddy-ai'];

/** 账号键 → 人话显示名（自定义优先，回落内置默认）；不认识的键原样返回 */
export function acctLabel(key) {
  return displayName(key);
}

/**
 * 账号维度判定：某模型归哪些账号管。
 * CN 裸名模型（step-5-preview / hy3 / hy4-preview）→ 本机；
 * -intl 后缀模型（hy3-intl / step-5-preview-intl …）→ 只归国际版（靠后缀路由）。
 */
export function accountsForModelGroup(group) {
  const g = String(group || '');
  if (g.endsWith('-intl')) return [{ key: 'workbuddy-ai', label: acctLabel('workbuddy-ai') }];
  return [
    { key: 'workbuddy', label: acctLabel('workbuddy') },
  ];
}

/** runtime → 账号键（CN variant=本机国内版，其余=国际版） */
export function acctKeyOfRuntime(rt, cnVariantId) {
  return rt.variant?.id === cnVariantId ? 'workbuddy' : 'workbuddy-ai';
}
