# Liahona Manager (v0.1)

The laptop app for the Liahona camp devices. This version covers people, teams and NFC cards. Journeys, the route builder and ball sync come next.

There are no packages to install. It runs on Node 18 or newer, and all data lives in one file, `data/liahona.json`.

## Run it

**Laptop:** `npm start`, then open http://localhost:3000. Phones and iPads on the same Wi-Fi can use the other address it prints (http://192.168.x.x:3000).

**iPad (StackBlitz):** open the project on stackblitz.com. It starts by itself (`.stackblitzrc`) and shows the app in the preview pane. StackBlitz keeps data only while the tab is open, so download a backup (Settings → Full backup) before closing it.

**Tests:** `npm test`

## What it does

**People**
- Add people one at a time. Enter keeps the cursor in the name box, so typing 100 names goes quickly.
- Import a CSV or paste rows. Columns can be in any order: `name` (or `first name` + `last name`), `role` (Youth/Leader; blank means Youth), `ward`, `age group`, `notes`, `team`. A plain list of names also works.
- Names already in the list are skipped, so re-importing an updated file is safe.
- `public/sample-roster.csv` has 100 made-up youth and 20 made-up leaders to practise with.

**Teams**
- Make N teams, then use **Auto-fill**. It spreads youth evenly, balancing age groups and wards, then gives each team 2 leaders.
- Move people by tapping them to select, then tapping **Move selected here**. This works on an iPad. On a laptop you can also drag.
- Each team header shows youth and leader counts against the target (8–10 youth, 2 leaders) and turns red when a team is outside it.
- Set a colour and a ball ID for each team. **Lock** a team once it's final, so it can't be changed by accident.

**Cards**
- **Bind cards** steps through a list (everyone, one team, or unassigned) one person at a time: "Next: Sarah Jones". Tap a medallion on the USB reader and it moves on to the next person.
- If a card already belongs to someone, you're asked before it's moved. Giving a person a new card marks their old one *lost*.
- Tap a name in the list to bind or replace that person's card next.
- With everyone done, scanning a card shows whose it is.

**Settings / Export**
- Card ID format: USB readers type IDs in different ways (hex, decimal, sometimes reversed). Use the test box to check a card against what the ball reads, and change the format until they match.
- Exports: the ball roster (JSON with every card ID → person → team), people and teams as a CSV, and a full backup.

## Card reader

Use a USB **13.56 MHz** reader that acts as a keyboard ("HID", "plug and play", "no driver"). It must read NTAG215 and should let you set the output format. Don't buy a 125 kHz reader, because it can't see NTAG cards.

Some cheap readers only send the first 4 bytes of a 7-byte NTAG ID. The app warns you when an ID isn't 7 bytes or doesn't start with `04`.

## Layout

```
server.js        HTTP server + API routes (no framework)
lib/store.js     data model: people, teams, cards, auto-fill, exports
lib/uid.js       card ID normalization
lib/csv.js       CSV import/export
public/          web UI (plain HTML/CSS/JS)
test/            node:test tests
data/            liahona.json (created on first run, not in git)
```
