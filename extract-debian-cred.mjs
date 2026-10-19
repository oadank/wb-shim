/**
 * extract-debian-cred.mjs
 * 在 Debian（已装 WorkBuddy 桌面端并登录）上运行：把本机 CN 账号的明文凭证导出来，
 * 输出可直接喂给 wb-shim 的 WORKBUDDY_AUTH_FILE（明文 JSON，优先级高于桌面端加密存储）。
 *
 * 用法（在 Debian 上）：
 *   1) 装包（一次性）：  npm i dsh-workbuddy-connect@0.7.1
 *   2) 运行：          node extract-debian-cred.mjs > debian-auth.json
 *   3) 把 debian-auth.json 安全传回 Windows（Tailscale/可信通道，别在聊天里贴 token）
 *
 * 注意：必须在 Debian 本机跑 —— 凭证是 WorkBuddy 用本机 at-rest key 加密的，
 *       跨机拷加密文件会因 keyId 不匹配解密失败（源码有 region/keyId 校验）。
 */
import { CN_VARIANT, WorkBuddyCredentialStore, WorkBuddyUpstreamClient } from 'dsh-workbuddy-connect';

const client = new WorkBuddyUpstreamClient();
const store = new WorkBuddyCredentialStore({
  variant: CN_VARIANT,
  // keyProvider 缺省会用本机 electron key helper 解密桌面端存储
  refresh: (c) => client.refreshToken(c),
});

const cred = await store.resolve();
if (!cred || !cred.accessToken) {
  console.error('未取到凭证：确认 Debian 上的 WorkBuddy 桌面端已登录 CN 账号');
  process.exit(1);
}

// 与 wb-shim 读取格式对齐（host-heartbeat 的 parseDesktopAuth：auth.* + account.*）
const out = {
  auth: {
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken ?? '',
    expiresAt: cred.expiresAtMs ?? 0,
    refreshExpiresAt: cred.refreshExpiresAtMs,
    domain: cred.domain ?? '',
  },
  account: {
    uid: cred.uid ?? '',
    nickname: cred.nickname ?? '',
    enterpriseId: cred.enterpriseId,
  },
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
console.error(`✓ 已导出 uid=${cred.uid} domain=${cred.domain}（明文写入 stdout，请妥善保管）`);
