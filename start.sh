#!/usr/bin/env bash
# ============================================================
#  TearDown - Ein-Klick-Start (Mac/Linux)
#  Funktioniert egal wo der Ordner liegt.
# ============================================================
set -e
cd "$(dirname "$0")"

echo ""
echo " =========================================="
echo "   TearDown - Physics Destruction Game"
echo " =========================================="
echo ""

# 1. Node.js pruefen
if ! command -v node >/dev/null 2>&1; then
  echo " [FEHLER] Node.js ist nicht installiert! -> https://nodejs.org"
  exit 1
fi
echo " [OK] Node.js $(node --version) gefunden"

# 2. BOM-Reparatur (fixt den PostCSS/JSON-Fehler)
for f in package.json tsconfig.json vite.config.ts index.html; do
  if [ -f "$f" ] && head -c 3 "$f" | grep -q $'\xef\xbb\xbf'; then
    sed -i.bak '1s/^\xef\xbb\xbf//' "$f" && rm -f "$f.bak"
    echo " [FIX] BOM entfernt: $f"
  fi
done

# 3. Neueste Version holen (falls Git vorhanden)
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  echo " [GIT] Hole neueste Version..."
  git pull --ff-only origin main 2>/dev/null || true
fi

# 4. Abhaengigkeiten installieren (nur beim ersten Mal)
if [ ! -d node_modules ]; then
  echo " [SETUP] Erste Installation..."
  npm install
fi

# 5. Starten — Browser oeffnet erst, wenn der Server wirklich antwortet
echo ""
echo " [START] Spiel startet auf http://localhost:5173"
echo " [INFO]  Dieses Terminal offen lassen - es IST der Server."
echo ""
(
  for i in $(seq 1 180); do
    if curl -s -o /dev/null --max-time 1 http://localhost:5173; then
      open http://localhost:5173 2>/dev/null || xdg-open http://localhost:5173 2>/dev/null
      break
    fi
    sleep 1
  done
) &
npm run dev
