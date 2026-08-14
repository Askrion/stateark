#!/bin/bash
# Doppelklickbar im Finder: installiert Abhaengigkeiten, baut und registriert StateArk.
cd "$(dirname "$0")" || exit 1
clear
echo "StateArk Update"
echo "==============="
echo "Ordner: $(pwd)"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "FEHLER: Node ist nicht installiert."
  echo "Bitte die LTS-Version von https://nodejs.org installieren und dieses Fenster erneut oeffnen."
  echo
  read -n 1 -s -r -p "Taste druecken zum Schliessen..."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 20 ]; then
  echo "FEHLER: Node $(node --version) ist zu alt, benoetigt wird v20 oder hoeher."
  echo
  read -n 1 -s -r -p "Taste druecken zum Schliessen..."
  exit 1
fi

set -e
echo "1/4  Abhaengigkeiten installieren..."; npm install --silent
echo "2/4  Selbsttest..."; npm test
echo "3/4  Bauen..."; npm run build
echo "4/4  In Claude Desktop registrieren..."; npm run install-claude-desktop
set +e

echo
echo "==============================================================="
echo " Fertig. Jetzt Claude Desktop mit Cmd+Q komplett beenden"
echo " und neu oeffnen. Danach im Chat fragen:"
echo "   \"welche StateArk-Tools hast du?\"  -> attach_artifact muss dabei sein"
echo "==============================================================="
echo
read -n 1 -s -r -p "Taste druecken zum Schliessen..."
