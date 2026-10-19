import os
import paramiko, json, time

# 认证：密钥优先，口令兜底（口令只从现成的用户级环境变量 N5105_SSH_PASSWORD 读，禁止明文入库）
HOST = os.environ.get('N5105_HOST', '100.110.110.12')
USER = os.environ.get('N5105_USER', 'root')
KEY = os.environ.get('N5105_SSH_KEY') or os.path.expanduser('~/.ssh/id_rsa_n5105')
PW = os.environ.get('N5105_SSH_PASSWORD', '')
USE_KEY = os.path.isfile(KEY)
if not USE_KEY and not PW:
    raise SystemExit('既无 SSH 密钥（~/.ssh/id_rsa_n5105）也无环境变量 N5105_SSH_PASSWORD，拒绝运行')
LOCAL_DEST = r'C:/D/opt/wb-shim/debian-auth.json'

mjs = r'''
import { CN_VARIANT, WorkBuddyCredentialStore, WorkBuddyUpstreamClient } from 'dsh-workbuddy-connect';
const client = new WorkBuddyUpstreamClient();
const store = new WorkBuddyCredentialStore({ variant: CN_VARIANT, refresh: (c) => client.refreshToken(c) });
const cred = await store.resolve();
if (!cred || !cred.accessToken) { console.error('NO_CRED'); process.exit(1); }
const out = {
  auth: {
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken ?? '',
    expiresAt: cred.expiresAtMs ?? 0,
    refreshExpiresAt: cred.refreshExpiresAtMs,
    domain: cred.domain ?? ''
  },
  account: { uid: cred.uid ?? '', nickname: cred.nickname ?? '', enterpriseId: cred.enterpriseId }
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
'''

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
connect_kw = dict(hostname=HOST, username=USER, timeout=25)
if USE_KEY:
    connect_kw['key_filename'] = KEY
    print(f'[auth] 使用 SSH 密钥 {KEY}')
else:
    connect_kw['password'] = PW
    print('[auth] 无密钥，回退口令（来自 N5105_SSH_PASSWORD）')
ssh.connect(**connect_kw)
sftp = ssh.open_sftp()
ssh.exec_command('mkdir -p /tmp/wbextract')
with sftp.open('/tmp/wbextract/extract.mjs', 'w') as f:
    f.write(mjs)

print('[1/3] installing dsh-workbuddy-connect@0.7.1 on Debian ...')
stdin, stdout, stderr = ssh.exec_command(
    'cd /tmp/wbextract && (test -d node_modules/dsh-workbuddy-connect || npm i dsh-workbuddy-connect@0.7.1 --no-audit --no-fund) >/tmp/wbextract/install.log 2>&1; echo DONE_INSTALL=$?',
    timeout=600)
print('install:', stdout.read().decode().strip(), stderr.read().decode().strip()[-300:])

print('[2/3] extracting credential (decrypt via /opt/WorkBuddy/workbuddy) ...')
stdin, stdout, stderr = ssh.exec_command(
    'cd /tmp/wbextract && WORKBUDDY_ELECTRON_BIN=/opt/WorkBuddy/workbuddy WORKBUDDY_AUTH_FILE=/root/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info node extract.mjs > /tmp/debian-auth.json 2>/tmp/wbextract/extract.err; echo EXIT=$?',
    timeout=180)
print('run stdout:', stdout.read().decode().strip())
rerr = stderr.read().decode().strip()
if rerr:
    print('run stderr tail:', rerr[-500:])

try:
    with sftp.open('/tmp/debian-auth.json', 'r') as f:
        data = f.read().decode()
    j = json.loads(data)
    print('[3/3] OK uid=%s domain=%s accessTokenLen=%d refreshTokenLen=%d' % (
        j.get('account', {}).get('uid'), j.get('auth', {}).get('domain'),
        len(j.get('auth', {}).get('accessToken', '')), len(j.get('auth', {}).get('refreshToken', ''))))
    with open(LOCAL_DEST, 'w') as out:
        out.write(data)
    print('saved ->', LOCAL_DEST)
except Exception as e:
    print('FAILED to read credential:', e)
    try:
        with sftp.open('/tmp/wbextract/extract.err', 'r') as f:
            print('extract.err:', f.read().decode()[-1000:])
    except Exception as e2:
        print('cannot read extract.err:', e2)
    try:
        with sftp.open('/tmp/wbextract/install.log', 'r') as f:
            print('install.log tail:', f.read().decode()[-1000:])
    except Exception:
        pass

# cleanup debian temp
try:
    sftp.remove('/tmp/debian-auth.json')
except Exception:
    pass
try:
    sftp.remove('/tmp/wbextract/extract.mjs')
except Exception:
    pass
ssh.close()
print('done')
