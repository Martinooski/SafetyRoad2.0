@echo off
setlocal
chcp 65001 >nul
title SafetyRoad 2.0 - Servicio local
cd /d "%~dp0backend"
set "SAFETYROAD_LAN=1"
set "SAFETYROAD_AUTO_OPEN=1"
set "SAFETYROAD_DOS_PANTALLAS=1"
echo.
echo  SAFETYROAD 2.0
echo  Iniciando sistema de reportes y panel del operador...
echo.
echo  Mantenga esta ventana abierta mientras use SafetyRoad.
echo  Para detenerlo: presione Ctrl + C.
echo.
where py >nul 2>&1
if not errorlevel 1 (
    py -3 servidor.py
) else (
    where python >nul 2>&1
    if errorlevel 1 (
        echo No se encontro Python 3. Instale Python y vuelva a intentarlo.
    ) else (
        python servidor.py
    )
)
echo.
echo El sistema se detuvo o no pudo iniciarse.
pause
