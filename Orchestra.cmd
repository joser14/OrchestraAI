@echo off
rem Orchestra launcher.
rem   Orchestra.cmd          start Orchestra: the live app (live\app) on the live data (live\data)
rem   Orchestra.cmd build    rebuild the Windows installer into installer\
rem Safe to run twice - the app is single-instance.
setlocal
set "HERE=%~dp0"
set "APP=%HERE%live\app"
set "ORCHESTRA_ROOT=%HERE%live\data"
if /i "%~1"=="build" goto build

set "ELECTRON=%APP%\desktop\node_modules\electron\dist\electron.exe"
if exist "%ELECTRON%" (
  start "" "%ELECTRON%" "%APP%\desktop"
  exit /b 0
)

rem No live copy: use the installed app, or offer the installer.
set "INSTALLED=%LOCALAPPDATA%\Programs\Orchestra\Orchestra.exe"
if not exist "%INSTALLED%" set "INSTALLED=%ProgramFiles%\Orchestra\Orchestra.exe"
if exist "%INSTALLED%" (
  start "" "%INSTALLED%"
  exit /b 0
)
for %%F in ("%HERE%installer\Orchestra Setup *.exe") do (
  echo Orchestra is not installed yet. Starting the installer: %%~nxF
  start "" "%%~fF"
  exit /b 0
)
echo Orchestra was not found in %APP% and no installer is in %HERE%installer
pause
exit /b 1

:build
pushd "%APP%\desktop"
call npx electron-builder --win nsis --config electron-builder.yml
if errorlevel 1 (
  popd
  echo Build failed.
  pause
  exit /b 1
)
del /q "%HERE%installer\Orchestra Setup *.exe" 2>nul
copy /y "dist\Orchestra Setup *.exe" "%HERE%installer\" >nul
rmdir /s /q dist
popd
echo Installer written to %HERE%installer
exit /b 0
