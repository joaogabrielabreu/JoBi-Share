@echo off
rem Cria o ambiente virtual e instala as dependencias (so na primeira vez).
cd /d "%~dp0.."
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import aiohttp, segno" 2>nul && exit /b 0
)
echo  Preparando o Janela (primeira execucao)...
where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
if not exist ".venv\Scripts\python.exe" (
  echo  [erro] Python 3.10+ nao encontrado. Instale em https://www.python.org/downloads/
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || exit /b 1
exit /b 0
