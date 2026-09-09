' Launches scripts/hub-loop.cmd with no console window.
'
' A scheduled task whose action is cmd.exe runs in the interactive session and
' parks a console window on the desktop for the whole logon. wscript's Run with
' intWindowStyle 0 is the standard way to suppress it; the task's own "run
' whether user is logged on or not" would do it too, but that mode needs the
' stored account password and puts the hub in session 0, where it can no longer
' start a dev server the user can see.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
' 0 = hidden, False = do not wait for it to finish.
shell.Run "cmd /c """ & here & "hub-loop.cmd""", 0, False
