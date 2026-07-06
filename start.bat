@echo off
chcp 65001 >nul
REM ============================================================
REM  TearDown - Ein-Klick-Start (Windows)
REM  Funktioniert per Doppelklick, egal wo der Ordner liegt.
REM ============================================================

REM In den Ordner wechseln, in dem diese Datei liegt
cd /d "%~dp0"

title TearDown - Physics Destruction Game
echo.
echo  ==========================================
echo    TearDown - Physics Destruction Game
echo  ==========================================
echo.

REM ---- 1. Node.js pruefen ------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo  [FEHLER] Node.js ist nicht installiert!
    echo  Bitte von https://nodejs.org herunterladen und installieren.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v gefunden

REM ---- 2. BOM-Reparatur (fixt den PostCSS/JSON-Fehler) -------
echo  [CHECK] Repariere Datei-Kodierung falls noetig...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($f in 'package.json','tsconfig.json','vite.config.ts','index.html') { if (Test-Path $f) { $b = [IO.File]::ReadAllBytes($f); if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { [IO.File]::WriteAllBytes((Resolve-Path $f), $b[3..($b.Length-1)]); Write-Host ('  [FIX] BOM entfernt: ' + $f) } } }"

REM ---- 3. Neueste Version holen (falls Git vorhanden) --------
if exist ".git" (
    where git >nul 2>nul
    if not errorlevel 1 (
        echo  [GIT] Hole neueste Version...
        git pull --ff-only origin main 2>nul
    )
)

REM ---- 4. Abhaengigkeiten installieren (nur beim ersten Mal) -
if not exist "node_modules" (
    echo  [SETUP] Erste Installation - das dauert kurz...
    call npm install
    if errorlevel 1 (
        echo  [FEHLER] npm install fehlgeschlagen!
        pause
        exit /b 1
    )
)

REM ---- 5. Browser oeffnen und Spiel starten ------------------
echo.
echo  [START] Spiel startet auf http://localhost:5173
echo  [INFO]  Zum Beenden dieses Fenster schliessen (oder Strg+C)
echo.
start /b cmd /c "timeout /t 3 >nul & start http://localhost:5173"
call npm run dev

pause
