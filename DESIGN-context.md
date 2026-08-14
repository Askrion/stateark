# Warum StateArk nicht "save early, save often" macht

Das Problem, das dieses Design löst: Ein Savepoint entsteht am Ende einer langen Session —
genau dann, wenn der Kontext des Modells am stärksten degradiert ist. Der Chat, der einen
Savepoint am dringendsten braucht, kann ihn am schlechtesten erzeugen.

Die naheliegende Antwort wäre, den Nutzer zu häufigerem Speichern zu drängen. Das ist die
Word-95-Antwort und sie verlagert die Arbeit auf den Menschen, den das Produkt eigentlich
entlasten soll.

StateArk löst es an drei anderen Stellen.

---

## 1. Die Rekonstruktionsdistanz verkürzen, nicht die Speicherfrequenz erhöhen

Zwei getrennte Objekte:

| | Savepoint | Journal-Eintrag |
| --- | --- | --- |
| Auslöser | **Du**, explizit | Modell, still |
| Kosten | teuer, konsolidiert | ~1 Zeile |
| Ergebnis | `v0.8`, kanonisch | `journal.ndjson`, roh |
| Sichtbar | ja | nein |

Beim Savepoint rekonstruiert das Modell nicht mehr aus 200 Seiten Chat, sondern aus
**Journal + aktuellem Kontext**. Das Journal ist die einzige Information, die garantiert
nicht wegkomprimiert wurde, weil sie den Chat verlassen hat, als sie noch frisch war.

Dein Bedienmodell ändert sich dabei **nicht**. Du sagst weiterhin nur `Savepoint`.

Wichtig: Das Journal ist ein *Zusatz*, keine Abhängigkeit. Wenn das Modell schlampig
journalt, ist das Ergebnis so gut wie ohne Journal — nie schlechter. Das ist die
Eigenschaft, die diese Wette vertretbar macht.

## 2. Das Tracking-Gate: welche Chats es wert sind

Deine Sorge war richtig — nicht jeder Chat verdient Buchhaltung. Die Antwort ist ein
Filter, den du sowieso schon bedienst:

```
note_event("Neues Projekt XY", ...)   ->  tracked: false, nichts passiert
```

`note_event` **verweigert** unbekannte Projekte. Serverseitig, nicht per Modell-Ermessen.
Ein Projekt wird journal-fähig genau dann, wenn du dort einmal `Savepoint` gesagt hast.

Daraus folgt:

- Brainstorming-Chat, Rezept-Frage, Übersetzung → StateArk fasst nichts an
- Session 1 eines echten Projekts → endet mit `Savepoint`, ab jetzt getrackt
- Session 2, 3, 4 → Journal läuft still mit

Der Nutzer trifft die Entscheidung "das ist es wert" also genau einmal, mit einer Geste,
die er ohnehin machen wollte.

## 3. Deterministische Prüfung statt Vertrauen

Das Journal hilft gegen *vergessene* Inhalte. Es hilft nicht gegen ein Modell, das beim
Savepoint schlampt. Dafür prüft StateArk serverseitig — ohne das Modell zu fragen:

| Prüfung | Auslöser |
| --- | --- |
| `artifact_carried_forward` | Datei aus v0.7 fehlt, nicht als gelöscht deklariert → wird kopiert |
| `artifact_became_pending` | war `stored`, ist jetzt `pending` → Inhalt vermutlich verloren |
| `artifact_shrank` | Datei auf unter 50 % geschrumpft (ab 200 Byte Ausgangsgröße) |
| `truncation_marker` | Datei enthält `// ... rest unchanged`, `[...]`, `… gekürzt` usw. |
| `no_change` | Savepoint ist identisch zum Vorgänger → leere Session gespeichert |
| `journal_not_reflected` | Journal enthielt Entscheidungen, der State listet keine |

Entscheidend ist das Verhalten bei einem Fund: **Der Savepoint wird trotzdem geschrieben.**
Arbeit geht nie verloren, nur weil eine Prüfung anschlägt. Die Warnungen landen im
Tool-Ergebnis, das Modell liest sie, und die Instructions verpflichten es, dich zu
informieren und Korrektur anzubieten. Ein Regelkreis statt eines Torwächters.

Der Carry-forward-Mechanismus ist dabei der wertvollste Teil: Weglassen ist jetzt
**sicher**. Das Modell muss unveränderte Dateien nicht mehr fehlerfrei reproduzieren —
es soll sie weglassen. Damit verschwindet die häufigste Ursache für stille Truncation,
statt sie nur zu erkennen.

## 4. Diff macht das Ganze überprüfbar

`diff_savepoints` beantwortet die Frage, die Snapshots allein nicht beantworten: *Was hat
sich zwischen v0.7 und v0.8 wirklich geändert?* Zeilenweiser LCS-Diff auf den Textfeldern,
Mengendiff auf den Listen, SHA-256-Vergleich auf den Artefakten — plus ein
`attention`-Block für alles, was nach stillem Verlust aussieht.

Ohne Argumente: neueste Version gegen ihren Vorgänger.

---

## Was bewusst nicht gebaut wurde

- **Kein Timer, kein Autosave.** Es gibt keinen "alle 30 Minuten"-Trigger. Nudges hängen
  an der Anzahl der Journal-Einträge (`STATEARK_JOURNAL_NUDGE_AT`, Default 20), also an
  echter Aktivität statt an Uhrzeit.
- **Kein Lesen des Chatverlaufs.** StateArk sieht ausschließlich Tool-Aufrufe, nie die
  Konversation. Das ist eine Architektureigenschaft, keine Einschränkung, die man später
  wegoptimieren sollte — sie ist Teil des Vertrauensversprechens.
- **Kein Branching.** Zwei parallele Chats am selben Projekt erzeugen weiterhin eine
  lineare Kette. Das ist eine bekannte Lücke, kein Versehen.
