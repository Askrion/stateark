# StateArk installieren

Alles läuft auf deinem Rechner. Nichts geht ins Netz, solange du Supabase nicht aktivierst.

Voraussetzung: **Node 20+**. Prüfen mit `node --version`; fehlt es, LTS von
<https://nodejs.org> installieren, Terminal neu öffnen.

## Heute: aus dem heruntergeladenen Ordner

`npx stateark` funktioniert **erst, wenn das Paket auf npm veröffentlicht ist.** Bis dahin
läuft die Installation aus dem entpackten Ordner. ZIP im Finder doppelklicken, den Ordner
`StateArk` nach Belieben ablegen (z. B. in `Programme` oder `Dokumente`), dann Terminal
öffnen und:

```bash
cd ~/Downloads/StateArk
npm install
npm run build
npm run setup
```

Tipp: statt den Pfad zu tippen, `cd ` eingeben (mit Leerzeichen) und den Ordner aus dem
Finder ins Terminalfenster ziehen.

Alternativ Doppelklick auf **`update.command`** im Finder — das macht dieselben vier
Schritte inklusive Selbsttest. Falls macOS blockt: Rechtsklick → *Öffnen* → *Öffnen*.

Danach Claude Desktop mit **Cmd+Q** komplett beenden (Fenster schließen reicht nicht) und
neu öffnen. Dann im Chat:

> Welche StateArk-Projekte habe ich?

## Befehle

Im Projektordner:

| Befehl | Was er tut |
| --- | --- |
| `npm run setup` | in Claude Desktop registrieren |
| `npm run report` | anonymisierte Nutzungsübersicht, nur für dich sichtbar |
| `node bin/stateark.mjs remove` | austragen; Savepoints bleiben liegen |
| `npm run setup -- --root ~/Documents/StateArk` | anderen Speicherort wählen |

Sobald das Paket auf npm liegt, wird daraus für alle anderen:

```bash
npx stateark            # registrieren
npx stateark report
npx stateark remove
```

Der Registrierungsschritt legt vor jeder Änderung eine Sicherungskopie deiner
`claude_desktop_config.json` an und fasst andere MCP-Server nicht an.

---

## Vorab: welcher Client kann StateArk überhaupt erreichen?

Das ist die entscheidende Frage und der Grund, warum es unten zwei Wege gibt.

| Client | Erreicht `localhost`? | Was du brauchst |
| --- | --- | --- |
| **Claude Desktop** (Config-Datei) | ja, per stdio | **Weg A** — empfohlen |
| **Claude Code** (Terminal) | ja, direkt über HTTP | **Weg B** |
| Claude Desktop / Cowork → „Custom Connector" (UI) | **nein** | öffentliche HTTPS-URL, also Tunnel |
| ChatGPT / Gemini Web | **nein** | öffentliche HTTPS-URL, also Tunnel |

Custom Connectors verbinden sich **aus Anthropics Cloud** zu deinem Server, nicht von
deinem Mac aus. Deshalb ist `http://localhost:8787` dort strukturell nicht erreichbar —
es gibt keinen Schalter dafür. Für den ersten Test nimm Weg A.

---

## Aus dem Quellpaket statt über npx

Wenn du das ZIP hast und den Code selbst bauen willst:

```bash
cd /Pfad/zu/StateArk
npm install
npm run typecheck && npm test     # 84 Checks - erst wenn das grün ist, weitermachen
npm run build
npm run setup                     # = npx stateark
```

Alternativ Doppelklick auf `update.command` im Finder, das macht alle vier Schritte.
Falls macOS blockt: Rechtsklick → *Öffnen* → *Öffnen*.

Der Eintrag, den `setup` schreibt, sieht so aus:

```json
{
  "mcpServers": {
    "stateark": {
      "command": "/pfad/zu/node",
      "args": ["/Pfad/zu/StateArk/dist/stdio.js"]
    }
  }
}
```

Claude Desktop startet StateArk selbst. Du musst nichts laufen lassen und kein Terminal
offen halten.

## Weg B — Claude Code (Terminal)

Hier läuft der HTTP-Agent. Erst starten:

```bash
npm start
```

Beim ersten Start wird ein Zufallsschlüssel erzeugt und angezeigt:

```
StateArk v0.5.1 local-first on http://localhost:8787
Root:        /Users/du/StateArk
MCP:         http://localhost:8787/mcp/AbC123...
```

Diese MCP-Zeile kopieren, **zweites** Terminalfenster öffnen:

```bash
claude mcp add --transport http stateark http://localhost:8787/mcp/DEIN_SCHLUESSEL
```

Das Terminal mit `npm start` muss dabei offen bleiben. Beenden mit `Ctrl+C`.

---

## Schritt 3 — Ausprobieren

Neuen Chat öffnen. Der Reihe nach:

**1. Verbindung prüfen**

> Welche StateArk-Projekte habe ich?

Erwartet: „No StateArk projects yet." Kommt stattdessen „ich habe keinen Zugriff",
ist die Verbindung nicht da — siehe Fehlersuche unten.

**2. Irgendetwas Echtes arbeiten.** Nimm eine kleine Sache, die du sowieso vorhast — eine
Gliederung, ein Skript, eine Preisüberlegung. Zwei, drei Iterationen, ruhig mit einem
verworfenen Ansatz dazwischen. Das ist wichtig: an einem leeren Projekt siehst du nicht,
ob die Konsolidierung etwas taugt.

**3. Speichern**

> Savepoint

**4. Nachsehen, was tatsächlich auf der Platte liegt**

```bash
open ~/StateArk/projects
```

`state.md` ist normales Markdown und in jedem Editor lesbar. Das ist der eigentliche Test:
Steht da wirklich der gültige Stand — oder eine chronologische Nacherzählung?

**5. Der Test, auf den es ankommt.** Chat schließen. **Neuen** Chat öffnen:

> Resume <dein Projektname>

Und dann etwas fragen, das nur beantwortbar ist, wenn der Stand wirklich angekommen ist —
zum Beispiel „warum haben wir Ansatz X verworfen?".

**6. Nach dem zweiten Savepoint**

> Zeig mir den Diff zwischen den letzten beiden Savepoints

---

## Update

```bash
npx stateark@latest
```

Danach Claude Desktop mit Cmd+Q beenden und neu öffnen. Prüfen:

> Welche StateArk-Tools hast du?

Aus dem Quellpaket: Ordner ersetzen (gleicher Pfad), dann `npm run update` oder Doppelklick
auf `update.command`.

Deine Savepoints in `~/StateArk` liegen außerhalb des Programmordners und überleben
jedes Update.

### Warum kein DMG?

Ein Doppelklick-Installer wäre für ein verkauftes Produkt der richtige Weg, für den
Prototyp aber ein Rückschritt:

- **Gatekeeper.** Ein unsigniertes DMG erzeugt auf aktuellem macOS „App ist beschädigt und
  kann nicht geöffnet werden". Damit es sauber läuft, braucht es ein Apple Developer
  Programm (99 USD/Jahr), ein Signaturzertifikat und Notarisierung bei Apple.
- **Node muss mit hinein.** Entweder als Single Executable gebündelt (~50-80 MB) oder als
  Abhängigkeit, die der Nutzer trotzdem installieren muss.
- **Updates werden schwerer, nicht leichter.** Jede Änderung müsste neu gebaut, signiert und
  notarisiert werden — bei einem Prototyp, der sich täglich ändert, ist das der falsche Takt.
- **Nur macOS.** Windows und Linux bräuchten je eigene Pakete.

Solange du der einzige Nutzer bist, ist `update.command` die bessere Antwort: gleicher
Doppelklick, kein Zertifikat, Sekunden statt Minuten pro Iteration. Sobald es zahlende
Nutzer gibt, ist ein signiertes DMG (oder ein `npx stateark`-Einzeiler) die richtige
Investition — dann aber einmal richtig, inklusive Notarisierung und Auto-Update.

---

## Fehlersuche

**„Ich habe keinen Zugriff auf StateArk"**
Claude Desktop wirklich mit `Cmd+Q` beendet? Das Schließen des Fensters reicht nicht.
Prüfen, ob der Eintrag angekommen ist:

```bash
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Weg A startet nicht**
Testen, ob der Einstiegspunkt für sich funktioniert:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node dist/stdio.js
```

Erwartet: eine JSON-Zeile mit `"name":"stateark"`. Fehlt `dist/`, hast du `npm run build` vergessen.

**`npm test` schlägt fehl**
Nichts anschließen, sondern mir die Ausgabe zeigen.

**Port 8787 belegt** (nur Weg B)

```bash
PORT=8899 npm start
```

**Savepoints woanders ablegen**

```bash
STATEARK_LOCAL_ROOT=~/Documents/StateArk npm start
```

Bei Weg A vor `npm run install-claude-desktop` setzen, dann landet es im Eintrag.

---

## Wieder entfernen

Weg A: den `"stateark"`-Block aus `claude_desktop_config.json` löschen (oder die
`.stateark-backup-*`-Datei zurückkopieren), Claude Desktop neu starten.
Weg B: `claude mcp remove stateark`.

Deine Savepoints bleiben in `~/StateArk` liegen — offene Dateien, unabhängig vom Tool.

---

## Veröffentlichen (für dich, nicht für Nutzer)

```bash
npm login
npm publish            # prepublishOnly laesst vorher typecheck + tests + build laufen
```

Vor dem ersten Mal prüfen:

- `npm pack --dry-run` — landet wirklich nur `dist/`, `bin/`, Doku und `supabase/` im Paket?
  Kein `.env`, kein `src/`, keine `node_modules`.
- `LICENSE` — der ausgelieferte Text ist ein **Platzhalter**. Vor Veröffentlichung durch
  eine geprüfte Lizenz ersetzen (PolyForm Noncommercial oder BUSL-1.1) und anwaltlich
  bestätigen lassen.
- Der Name `stateark` war zuletzt frei. Mit `npm view stateark` gegenprüfen.
- Nach `npm publish` ist die Version unwiderruflich belegt; für Korrekturen `0.5.2` usw.

Nutzungsdaten bekommst du ausschließlich, wenn Nutzer dir freiwillig den Block aus
`npx stateark report` schicken. Es gibt keine Telemetrie, und das sollte auch so bleiben —
es ist bei dieser Zielgruppe dein stärkstes Argument.
