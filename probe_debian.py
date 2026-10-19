import os
import paramiko

# 认证：密钥优先，口令兜底（口令只从现成的用户级环境变量 N5105_SSH_PASSWORD 读，禁止明文入库）
host = os.environ.get('N5105_HOST', '100.110.110.12')
user = os.environ.get('N5105_USER', 'root')
key = os.environ.get('N5105_SSH_KEY') or os.path.expanduser('~/.ssh/id_rsa_n5105')
pw = os.environ.get('N5105_SSH_PASSWORD', '')
use_key = os.path.isfile(key)
if not use_key and not pw:
    raise SystemExit('既无 SSH 密钥（~/.ssh/id_rsa_n5105）也无环境变量 N5105_SSH_PASSWORD，拒绝运行')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
if use_key:
    print('[auth] 使用 SSH 密钥', key)
    ssh.connect(host, username=user, key_filename=key, timeout=25)
else:
    print('[auth] 无密钥，回退口令（来自 N5105_SSH_PASSWORD）')
    ssh.connect(host, username=user, password=pw, timeout=25)

cmd = r'''
echo "=== OS ==="; head -3 /etc/os-release
echo "=== node/npm ==="; node --version 2>&1; npm --version 2>&1; which node npm 2>&1
echo "=== auth dirs ==="; ls -la "$HOME/.config/CodeBuddyExtension/Data/Public/auth/" 2>/dev/null; ls -la "$HOME/.local/share/CodeBuddyExtension/Data/Public/auth/" 2>/dev/null
echo "=== /opt ==="; ls /opt 2>/dev/null
echo "=== /usr/local/bin ==="; ls /usr/local/bin 2>/dev/null | head -30
'''
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=90)
out = stdout.read().decode()
err = stderr.read().decode()
print(out)
if err.strip():
    print("ERR:\n" + err)
ssh.close()
