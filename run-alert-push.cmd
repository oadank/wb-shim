@echo off
REM wb-alert-push launcher. ASCII only (cmd chokes on UTF-8 comments).
setlocal
set LARK_APP_ID=cli_a93fe9c803b89cc8
set LARK_ALERT_AT_OPEN_ID=ou_888b94e17b7d3d6dcc21ddbc6b35abb4
set ALERT_POLL_MS=60000
set ALERT_STATE_FILE=C:\D\opt\wb-shim\.alert-push-state.json
set WB_SHIM_ALERTS_URL=http://127.0.0.1:18796/alerts
for /f "usebackq tokens=* delims=" %%S in ("C:\D\opt\wb-shim\lark-secret.txt") do set LARK_APP_SECRET=%%S
cd /d C:\D\opt\wb-shim
"C:\Program Files\nodejs\node.exe" "C:\D\opt\wb-shim\alert-push.mjs" >> logs\alert-push-stdout.log 2>> logs\alert-push-stderr.log
