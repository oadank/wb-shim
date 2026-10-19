import os
import paramiko

# 密码走环境变量，禁止明文入库（.gitignore 另有兜底）
host = os.environ.get('N5105_HOST', '100.110.110.12')
user = os.environ.get('N5105_USER', 'root')
pw = os.environ.get('N5105_PASS', '')
if not pw:
    raise SystemExit('缺少环境变量 N5105_PASS（N5105 root 密码），拒绝运行')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
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
