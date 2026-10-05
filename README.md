# STEELTRACK

Factory and site tracking for steel fabrication: fabrication progress,
materials, QA/QC, NCRs, delivery notes, site erection, office records.

**To set up the shared cloud version, follow [SETUP.md](SETUP.md).**

## How it's organised

| Path | What |
|---|---|
| `SteelTrack-Updated/FACTORY_TRACK_AND_STOCK_….html` | The app itself (keep updating it as before) |
| `src/cloud/` | The cloud layer: logins, live sync, permissions, cloud files, admin page |
| `tools/build.py` | Turns the app file into the published page (`public/index.html`) |
| `rules/` | Security rules for the database, Firestore and file storage |
| `steeltrack.config.json` | Firebase settings, admin email, which app file to build |
| `.github/workflows/deploy.yml` | Builds and publishes on every push to `main` |
| `test/` | Sync-logic unit tests and a three-browser end-to-end test |

## How the sync works (short version)
The app's modules save into the browser's `localStorage`. The cloud layer hooks
those saves and keeps each shared key in step with Firebase Realtime Database
at `data/<section>/<key>`. Values are stored as a tree so an edit only sends the
part that changed; simultaneous edits are merged. Attachments go to Cloud
Storage at `files/<section>/<module>/<file>`. Which key belongs to which section
is in `src/cloud/00-config.js`.

## Tests
```
node test/codec.test.js                 # sync logic
cd test && npm install && cd ..
python3 test/e2e.py                     # admin + site + factory browsers against a local Firebase stand-in
```
