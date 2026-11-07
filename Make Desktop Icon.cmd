@echo off
rem Run once: puts a "Liahona Manager" icon on the desktop and in the Start menu.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$here = (Get-Location).Path;" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {" ^
  "  $lnk = $shell.CreateShortcut((Join-Path $dir 'Liahona Manager.lnk'));" ^
  "  $lnk.TargetPath = (Join-Path $here 'Liahona Manager.cmd');" ^
  "  $lnk.WorkingDirectory = $here;" ^
  "  $lnk.IconLocation = (Join-Path $here 'public\liahona.ico');" ^
  "  $lnk.WindowStyle = 7;" ^
  "  $lnk.Description = 'Liahona camp manager';" ^
  "  $lnk.Save();" ^
  "  Write-Host ('Made ' + $lnk.FullName) }"
echo.
echo Done. Double-click "Liahona Manager" on the desktop to start it.
pause
