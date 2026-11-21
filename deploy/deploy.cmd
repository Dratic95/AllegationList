@echo off
rem deploy.cmd - uploads the bot to the server and installs/updates it there.
rem
rem   deploy\deploy.cmd ubuntu@<server IP> <path to your SSH private key>
rem
rem Example:
rem   deploy\deploy.cmd ubuntu@141.147.10.20 "%USERPROFILE%\.ssh\oracle-bot.key"
rem
rem Uses the ssh, scp and tar programs built into Windows 10 and 11. Run it again whenever
rem the code changes; the server keeps its own data.json (see DEPLOY.md).

setlocal
if "%~1"=="" goto usage
if "%~2"=="" goto usage

set "TARGET=%~1"
set "KEY=%~2"
set "ROOT=%~dp0.."
set "ARCHIVE=%TEMP%\allegationlist-upload.tgz"

rem Use the tar/ssh/scp that ship with Windows. Another tar on the PATH (for example Git's)
rem reads "C:" in a path as a remote host name and fails.
set "TAR=%SystemRoot%\System32\tar.exe"
if not exist "%TAR%" set "TAR=tar"
set "SSH=%SystemRoot%\System32\OpenSSH\ssh.exe"
if not exist "%SSH%" set "SSH=ssh"
set "SCP=%SystemRoot%\System32\OpenSSH\scp.exe"
if not exist "%SCP%" set "SCP=scp"

if not exist "%KEY%" (
  echo The key file "%KEY%" doesn't exist.
  exit /b 1
)
if not exist "%ROOT%\.env" (
  echo Warning: there is no .env in the project folder. The server must already have one.
)

rem "accept-new" trusts the server's fingerprint the first time and refuses if it ever changes.
set SSH_OPTS=-i "%KEY%" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20

echo.
echo ==^> Packing the project
if exist "%ARCHIVE%" del /q "%ARCHIVE%"
"%TAR%" -czf "%ARCHIVE%" -C "%ROOT%" --exclude=node_modules --exclude=.git --exclude=.claude --exclude=.codegraph --exclude="data.json.tmp" --exclude="data.json.corrupt-*" --exclude="data.json.bak-*" --exclude="*.log" .
if errorlevel 1 goto failed

echo.
echo ==^> Uploading to %TARGET%
"%SCP%" %SSH_OPTS% "%ARCHIVE%" "%TARGET%:allegationlist-upload.tgz"
if errorlevel 1 goto failed
del /q "%ARCHIVE%"

echo.
echo ==^> Installing on the server
"%SSH%" %SSH_OPTS% "%TARGET%" "set -e; rm -rf ~/allegationlist-upload; mkdir ~/allegationlist-upload; tar -xzf ~/allegationlist-upload.tgz -C ~/allegationlist-upload; rm -f ~/allegationlist-upload.tgz; status=0; sudo bash ~/allegationlist-upload/deploy/setup-server.sh || status=$?; rm -rf ~/allegationlist-upload; exit $status"
if errorlevel 1 goto failed

echo.
echo Done. The bot is running on the server. Don't also start it on this PC.
exit /b 0

:usage
echo Usage: deploy\deploy.cmd ubuntu@^<server IP^> ^<path to SSH private key^>
exit /b 1

:failed
if exist "%ARCHIVE%" del /q "%ARCHIVE%"
echo.
echo Deploy FAILED. Read the messages above; DEPLOY.md has a troubleshooting section.
exit /b 1
