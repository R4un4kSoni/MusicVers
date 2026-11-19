@echo off
setlocal
cd /d "%~dp0..\.."

echo Installing build dependencies...
python -m pip install --upgrade pip
python -m pip install -r requirements-build.txt

echo Building MusicVer.exe...
python -m PyInstaller --noconfirm --clean packaging\windows\musicver.spec

echo.
echo Done: dist\MusicVer.exe
endlocal
