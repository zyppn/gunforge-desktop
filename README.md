# GUNFORGE — desktop app (.exe / .dmg)

Electron project. The game is the renderer; a small native shell stores saves as a
JSON file in the OS app-data folder (survives reinstalls/updates), and
`electron-builder` produces the installers.

## Project layout
```
main.js                     Electron main process: window + file-based save store (IPC)
preload.js                  Secure bridge exposing window.gunforgeNative.get/set
renderer/index.html         The game (three.js bundled locally — fully offline-capable)
renderer/vendor/three.min.js
.github/workflows/build.yml CI that builds .exe, .dmg and .AppImage
supabase-setup.sql          Optional online auction backend
```

## Run in development
```
npm install
npm start
```

## Build installers

Installers must be built on their own OS: `.exe` on Windows, `.dmg` on macOS.
That's why the included GitHub Actions workflow is the practical route:

1. Push this folder to a GitHub repo.
2. Tag a release: `git tag v1.0.0 && git push --tags`
   (or run the workflow manually from the Actions tab).
3. CI builds on Windows, macOS and Linux runners and uploads
   `GUNFORGE Setup 1.0.0.exe`, `GUNFORGE-1.0.0.dmg`, and a Linux `.AppImage`
   as downloadable artifacts. Attach them to a GitHub Release for players.

Local builds work too if you're on the matching OS: `npm run dist:win` / `dist:mac`.

**Shipping updates:** bump `"version"` in package.json, push a new tag, attach the
new installers. (Later, `electron-updater` + GitHub Releases can make the app
self-update in place — say the word and I'll wire it.)

**macOS note:** the .dmg is unsigned, so first launch requires right-click → Open.
Removing that prompt requires an Apple Developer ID ($99/yr) + notarization,
which electron-builder supports when you're ready.

## Storage & the auction in the desktop app

- **Profile/parts/credits:** saved natively to `gunforge-save.json` in the app-data
  folder — real persistence, independent of any browser.
- **Auction house:** by default it's device-local. To make it a true online market
  shared by every installed copy, create a Supabase project, run
  `supabase-setup.sql`, and fill in `BACKEND` near the top of
  `renderer/index.html`'s script. The desktop app then talks to the same live
  market as any deployed web version. (Demo-grade policies — see the SQL's
  comments for the production-hardening path.)

## Live PvP roadmap (unchanged by going desktop)

Desktop packaging doesn't change the netcode reality: real-time PvP needs an
authoritative server (Colyseus/Node on Fly.io or Railway) relaying inputs and
adjudicating hits. The desktop client connects to it over WebSocket exactly like
a web client would. Shared-economy multiplayer (the Supabase market) works today.


