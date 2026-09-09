@echo off
rem Keeps the lightbox hub on :4000 up for the life of the logon session.
rem
rem Registered as the per-user scheduled task "Lightbox hub" (see
rem scripts/install-tasks.cmd), launched hidden through hub-hidden.vbs so no
rem console window sits on the desktop.
rem
rem Why a loop rather than the task's own restart-on-failure: schtasks can only
rem express that through task XML, and a task that "fails" is also how a clean
rem `stopAll` shutdown looks. A loop here treats every exit the same and costs
rem one idle cmd.exe.
rem
rem The hub itself is cheap to leave running. src/supervisor.mjs starts no dev
rem server eagerly ("Forty dev servers at once is not a review setup, it is a
rem way to run a machine out of memory"), so an idle hub is one node process.
setlocal
cd /d "%~dp0.."
if not exist ".lightbox" mkdir ".lightbox"

:loop
rem Never start a second hub. If anything already holds :4000 - a hub started by
rem hand mid-walk, or another copy of this loop - wait it out rather than
rem racing it. Binding the port is the only honest test; a process-name check
rem would miss a hub started from a different shell.
node -e "const n=require('net'),s=n.createServer();s.once('error',()=>process.exit(1));s.once('listening',()=>s.close(()=>process.exit(0)));s.listen(4000,'127.0.0.1')" >nul 2>&1
if errorlevel 1 (
  timeout /t 30 /nobreak >nul
  goto loop
)

echo [hub-loop] starting %DATE% %TIME% >> ".lightbox\serve.log"
node bin\lightbox.mjs serve >> ".lightbox\serve.log" 2>&1
echo [hub-loop] exited with %ERRORLEVEL% %DATE% %TIME% >> ".lightbox\serve.log"

rem A crash loop should not spin the CPU. Ten seconds is long enough that a
rem repeated failure is visible in serve.log as distinct timestamps.
timeout /t 10 /nobreak >nul
goto loop
