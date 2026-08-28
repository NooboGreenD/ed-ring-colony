@echo off
cd /d "%~dp0"
if exist "RingColonyUploader.exe" (
  start "" "RingColonyUploader.exe"
  exit /b 0
)
if exist "dist\RingColonyUploader.exe" (
  start "" "dist\RingColonyUploader.exe"
  exit /b 0
)
echo EXE not found. Building standalone app...
call "%~dp0build.bat"
if exist "RingColonyUploader.exe" (
  start "" "RingColonyUploader.exe"
  exit /b 0
)
echo Could not build EXE. Trying Python instead...
python ring_uploader.py
if errorlevel 1 py -3 ring_uploader.py
pause
