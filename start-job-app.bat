@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 检查 3000 端口是否已在运行
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo Job Portal already running, opening browser...
  start http://localhost:3000
  goto :end
)

echo Starting Job Portal... keep this window open.
echo Browser will open http://localhost:3000
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause

:end
