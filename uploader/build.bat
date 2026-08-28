@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set PY=py -3
) else (
  set PY=python
)

echo Installing PyInstaller...
%PY% -m pip install --upgrade pyinstaller
if errorlevel 1 (
  echo Failed to install PyInstaller.
  exit /b 1
)

echo Building RingColonyUploader.exe ...
%PY% -m PyInstaller --noconfirm --clean --windowed --onefile ^
  --name "RingColonyUploader" ^
  --distpath dist ^
  --workpath build ^
  --specpath build ^
  ring_uploader.py
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)

copy /Y "dist\RingColonyUploader.exe" "RingColonyUploader.exe" >nul
echo.
echo Ready: %cd%\RingColonyUploader.exe
echo Copy this file anywhere — Python is not required to run it.
exit /b 0
