@echo off
rem Janela - inicia o servidor com link publico (internet) + rede local.
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0scripts\setup.bat" || goto :fail
".venv\Scripts\python.exe" server.py --public %*
goto :eof

:fail
echo.
echo  Nao foi possivel preparar o ambiente. Veja a mensagem acima.
pause
