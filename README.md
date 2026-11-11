# Liahona Manager (v0.3)

The manager for the Liahona camp devices. It covers people, teams, NFC medallions, Journeys and Places, a public sign-up form, and accounts with roles. The route builder (maps and GPS), the ball preview and ball sync come next.

**The same app runs in two places:**
- **In the cloud (AWS):** the main copy before and after camp. Leaders sign in with their own accounts, families use the sign-up form, and changes deploy from GitHub automatically. Setup is in [docs/cloud-setup.md](docs/cloud-setup.md).
- **On the camp laptop:** works with no internet. **Download for camp** brings everything down from the cloud and makes the cloud read-only; **Upload after camp** sends it all back.

On the laptop there are no packages to install. It runs on Node 18 or newer, and all data lives in one JSON file (see below for where).

## Roles

| Role | Can do |
|---|---|
| **Admin** | Everything: users, event settings, deleting data, the camp laptop |
| **Planner** | Journeys, places, media, teams, cards. Sees names, ward, age and team, not private details |
| **Registrar** | Sign-ups and full participant details (contacts, health, permission) |
| **Leader** | Read-only. Sees private details only for their own team (matched by the email on their People entry) |

- **In the cloud,** an Admin invites people under **Users**.
- **On the laptop,** whoever sits at it is Admin. Phones and iPads on the camp Wi-Fi sign in with their email and a code for their role (**Settings → Sign-in codes**).

## Sign-up form

- **Where:** `/register` (e.g. `https://…cloudfront.net/register`) is the only page anyone can open without signing in.
- **What it collects:** youth details, parents, emergency contact, health, and the parent's permission with a typed signature.
- **Open or closed:** set in **Settings → Event**, along with the event name and theme. The theme can change at any time.
- **Reviewing:** submissions wait under **Sign-ups** until a Registrar approves them into People. Ages are worked out for the event's first day.
- **Changing the questions:** they're listed in `lib/registration.js`.

## Run it

**Windows, from an icon:** double-click **Make Desktop Icon.cmd** once. It puts a *Liahona Manager* icon on the desktop and in the Start menu. Clicking the icon starts the app and opens it in the browser. A small minimized window keeps it running; close that window to stop the app. Clicking the icon again while it's running just opens the browser.

Data is saved in **Documents\Liahona Data\liahona.json**, separate from the code, so `git pull` never touches it. The first launch copies over anything already in the repo's `data` folder. Once a day it saves a copy in `Liahona Data\backups` and keeps the last 30. No internet is needed at any point.

**From a terminal:** `npm start`, then open http://localhost:3000. Phones and iPads on the same Wi-Fi can use the other address it prints (http://192.168.x.x:3000).

**iPad (StackBlitz):** open the project on stackblitz.com. It starts by itself (`.stackblitzrc`) and shows the app in the preview pane. StackBlitz keeps data only while the tab is open, so download a backup (Settings → Full backup) before closing it.

**Tests:** `npm test` (the S3 test needs `npm install` first; the rest run with nothing installed)

## What it does

**People**
- Add people one at a time. Enter keeps the cursor in the name box, so typing 100 names goes quickly.
- Import a CSV or paste rows. Columns can be in any order: `name` (or `first name` + `last name`), `role` (Youth/Leader; blank means Youth), `ward`, `age` (a whole number 13–18, youth only), `notes`, `team`. A plain list of names also works.
- Names already in the list are skipped, so re-importing an updated file is safe.
- `public/sample-roster.csv` has 100 made-up youth and 20 made-up leaders to practise with.

**Teams**
- Make N teams, then use **Auto-fill**. It spreads youth evenly, balancing ages and wards, then gives each team 2 leaders.
- Move people by tapping them to select, then tapping **Move selected here**. This works on an iPad. On a laptop you can also drag.
- Each team header shows youth and leader counts against the target (8–10 youth, 2 leaders) and turns red when a team is outside it.
- Set a colour and a ball ID for each team. **Lock** a team once it's final, so it can't be changed by accident.

**Cards**
- **Bind cards** steps through a list (everyone, one team, or unassigned) one person at a time: "Next: Sarah Jones". Tap a medallion on the USB reader and it moves on to the next person.
- If a card already belongs to someone, you're asked before it's moved. Giving a person a new card marks their old one *lost*.
- Tap a name in the list to bind or replace that person's card next.
- With everyone done, scanning a card shows whose it is.

**Journeys**
- Each Journey is a YAML file in `Liahona Data\journeys`. Media for it goes in `Liahona Data\media\<media folder>`.
- **Load the Leader Trial** gives you a full example to start from, and adds its places.
- The editor shows Journey settings plus a list of Stages. Each Stage has its gathering, an optional brief and travel, and its Tasks. The form fields change with the Task type (17 types: questions, find the verse, put in order, audio and hymn clues, check-ins, gather the fragments, cipher, be still, sing, hold the course, leader approves, scripted darkening and more).
- The checker runs as you type. **Errors** (a blank question, an answer that points past the end of the list, a duplicate Stage ID) stop a Journey from going to the balls. **Warnings** are things to finish before the run: places not set up, tags not bound, media files not added yet. Click a problem to jump to it.
- Save with the button or Ctrl+S. **YAML view** shows the file and lets you edit it directly. Comments are kept when you import a file, but not once you save from the designer.
- **Ball file** downloads the compiled JSON a ball loads. It's only offered once the Journey has no errors.

**Places**
- Every spot a Journey sends a team, or a tag it asks them to tap. **Add them** creates every place a Journey uses. Places reached by written directions start as *tag-only* (indoors, no GPS).
- **Bind tags** works like the medallions: pick a place (or go through the ones with no tag) and tap its tag on the USB reader. A place can have more than one tag, for spares. A tag can't be both a place tag and a member medallion.
- GPS positions come later, with the route builder.

**Settings / Export**
- Card ID format: USB readers type IDs in different ways (hex, decimal, sometimes reversed). Use the test box to check a card against what the ball reads, and change the format until they match.
- **Delete all data:** type DELETE to wipe every person, team and card (for example, after practising with the sample roster). A copy goes to the backups folder first, and the reader settings are kept.
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
public/shared/   journey.js: Task types, checker and compiler (used by both server and browser)
public/vendor/   js-yaml (MIT), bundled so there's nothing to install
lib/journeys.js  Journey files on disk
samples/         leader-trial.yaml
test/            node:test tests
data/            liahona.json (created on first run, not in git)
```

## Windows notes

- If PowerShell says *running scripts is disabled*, use `npm.cmd start` or `node server.js`. Or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
- To keep the data somewhere else (a USB stick, say), set the `LIAHONA_DATA` environment variable to the full path of the JSON file.
