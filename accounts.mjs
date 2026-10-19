/**
 * accounts.mjs —— 账号维度唯一真源（2026-10-19 dsh 建）
 *
 * 为什么要有这个文件：wb-shim 有三个账号（本机 Lecoo / 国际版 Lecoo-intl / N5105 Debian），
 * 账号键 → 显示名的映射曾经散在 daemon.mjs 9 处 + rate-guard.mjs 1 处，各写一遍三目表达式。
 * 改一处漏八处 = 页面名字对不上（真实发生过）。现在全收口到这里，谁要显示名都 import。
 *
 * 账号键（account key）是状态文件 .rate-guard-state.json 的键前缀，形如 `workbuddy-ai:模型名`：
 *   workbuddy       本机国内版（LeCoo，CN variant）
 *   workbuddy-ai    本机国际版（WorkBuddy AI，INTL variant）
 *   workbuddy-deb   N5105 小主机（Debian，独立积分池，专用 token 路由）
 *
 * 铁律：新增/改名只改本文件，别处一律 import。
 */

/** 账号键 → 人话显示名（老大 2026-10-18 定，2026-10-19 收口） */
const ACCOUNT_LABELS = {
  'workbuddy': 'Lecoo',
  'workbuddy-ai': 'Lecoo-intl',
  'workbuddy-deb': 'N5105',
};

/** 账号键 → 人话显示名；不认识的键原样返回（别显示 undefined） */
export function acctLabel(key) {
  return ACCOUNT_LABELS[key] || key;
}

/** 账号键列表（按展示顺序：国内、国际、Debian） */
export const ACCOUNT_KEYS = ['workbuddy', 'workbuddy-ai', 'workbuddy-deb'];

/**
 * 账号维度判定：某模型归哪些账号管。
 * CN 裸名模型（step-5-preview / hy3 / hy4-preview）→ 本机 Lecoo + N5105；
 * -intl 后缀模型（hy3-intl / step-5-preview-intl …）→ 只归国际版 Lecoo-intl（靠后缀路由）。
 */
export function accountsForModelGroup(group) {
  const g = String(group || '');
  if (g.endsWith('-intl')) return [{ key: 'workbuddy-ai', label: acctLabel('workbuddy-ai') }];
  return [
    { key: 'workbuddy', label: acctLabel('workbuddy') },
    { key: 'workbuddy-deb', label: acctLabel('workbuddy-deb') },
  ];
}

/** runtime → 账号键（Debian 标 isDebian；CN variant=本机国内版，其余=国际版） */
export function acctKeyOfRuntime(rt, cnVariantId) {
  if (rt.isDebian) return 'workbuddy-deb';
  return rt.variant?.id === cnVariantId ? 'workbuddy' : 'workbuddy-ai';
}
