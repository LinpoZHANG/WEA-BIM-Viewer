@echo off
rem WEA launcher (Windows). Finds a real Python 3.10+ (py launcher, python3.x commands, python.org install folders;
rem the Microsoft Store "python" placeholder is rejected because it cannot run code), installs the dependencies
rem once into .venv (PyPI, then a China mirror) and starts the server, which opens the browser when ready.
rem Logs: logs\wea.log, logs\install.log
cd /d "%~dp0"
if not exist logs mkdir logs
set "PY="
set "CHECK=import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)"
for %%C in ("py -3.12" "py -3.11" "py -3.10" python3.12 python3.11 python3.10 python3 python) do if not defined PY (%%~C -c "%CHECK%" >NUL 2>NUL && set "PY=%%~C")
for %%V in (312 311 310) do if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
for %%V in (312 311 310) do if not defined PY if exist "%ProgramFiles%\Python%%V\python.exe" set PY="%ProgramFiles%\Python%%V\python.exe"
if not defined PY (
  echo Python 3.10+ was not found. Install Python 3.11 from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run this file again.
  echo %date% %time% no python 3.10+ found >> logs\wea.log
  pause & exit /b 1
)
echo Using Python: %PY%
if not exist .venv\.wea-ok (
  echo First run: installing components into .venv ^(internet required, 3-5 minutes^)...
  if not exist .venv\Scripts\python.exe %PY% -m venv .venv
  if not exist .venv\Scripts\python.exe (echo Could not create .venv with %PY% & echo %date% %time% venv failed with %PY% >> logs\wea.log & pause & exit /b 1)
  .venv\Scripts\python -m pip install -r requirements.txt >> logs\install.log 2>&1 || .venv\Scripts\python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple >> logs\install.log 2>&1
  if errorlevel 1 (echo Some components failed to install ^(see logs\install.log^). The model can still be viewed; the next start retries.) else (type nul > .venv\.wea-ok & echo Done.)
)
set PYTHONIOENCODING=utf-8
.venv\Scripts\python server.py
pause
