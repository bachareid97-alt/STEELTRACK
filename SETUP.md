# SteelTrack Cloud — setup guide

After this setup, everyone in the factory and on site opens **one web address**,
signs in with **their own account**, and sees the **same live data**. When
someone edits, uploads or updates anything, everyone else sees it within a
second or two.

You do steps 1–8 once (about 30 minutes). Steps 9–12 are the switch-over.

---

## What you get

| | |
|---|---|
| **One address for everyone** | e.g. `https://steeltrack-xxxx.web.app` (you can add your own domain later) |
| **Personal logins** | Each person signs up with their email; nobody gets in until you approve them |
| **Access per section** | For each person: *No access / View only / Can edit* on Projects, Technical, Factory, Site, Office |
| **Live updates** | Changes reach every open screen within seconds; two people editing at once don't overwrite each other |
| **Attachments for everyone** | PDF, Excel, AutoCAD (DWG/DXF), IFC, Word, ZIP, photos — up to 2 GB per file |
| **Safety** | Google's servers enforce the permissions; daily previous-version backups kept 14 days; one-click full download |

**Cost:** Firebase's pay-as-you-go plan is $0 until you pass the free amounts
(5 GB of files, 1 GB of data, 10 GB/month of downloads). After that it's cents
per GB. Set the budget alert in step 2 so you're emailed long before any real
cost.

---

## 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and sign in with the Google account that should own SteelTrack.
2. **Create a project** → name it `steeltrack` → you can switch Google Analytics **off** → Create.

## 2. Turn on pay-as-you-go (needed for file storage) + a budget alert
1. Bottom-left: **Upgrade** → **Blaze** → add a card.
2. When asked, set a **budget alert**, e.g. **$10 per month**. (Google emails you; it doesn't stop the app.)

## 3. Turn on email sign-in
**Build → Authentication → Get started → Email/Password → Enable → Save.**

## 4. Create the Realtime Database (the live data)
**Build → Realtime Database → Create database** → location **Belgium (europe-west1)** → **Start in locked mode** → Enable.

## 5. Create Firestore (holds a copy of each person's access, used to protect files)
**Build → Firestore Database → Create database** → **Standard** edition → same region (**europe-west1**) → **production mode** → Create.

## 6. Create Storage (the attachments)
**Build → Storage → Get started** → **production mode** → same region → Done.

## 7. Get the web settings and put them in `steeltrack.config.json`
1. ⚙️ **Project settings → General** → scroll to **Your apps** → click **`</>`** (Web) → nickname `steeltrack` → **Register app** (don't tick Hosting here).
2. It shows a `firebaseConfig = { ... }` block. Copy the seven values into
   `steeltrack.config.json` in this repository (replace each `PASTE_FROM_FIREBASE_CONSOLE`).
   These values are not secret — the security rules are what protect the data.
3. Check `"adminEmail"` in the same file is **your** email. That account becomes the
   first administrator automatically (once its email is confirmed).

## 8. Let GitHub publish the app automatically
1. In Firebase: ⚙️ **Project settings → Service accounts → Generate new private key** → it downloads a `.json` file. **Keep it private** — it's a master key.
2. In GitHub: this repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: open the downloaded `.json` file in Notepad, copy **everything**, paste.
3. Delete the downloaded `.json` file from your computer.
4. **Make the repository private:** repo → **Settings** → scroll to the bottom → **Change visibility → Private**.
   (Older versions of the app file in this repo contain your project data and drawings.)

From now on, every push to `main` rebuilds the app and publishes it, together
with the security rules. You can watch it under the repo's **Actions** tab.

> If the publish step fails with a *permission* error: open
> <https://console.cloud.google.com/iam-admin/iam>, find the account whose name
> starts with `firebase-adminsdk`, click ✏️, **Add another role → Firebase Admin**, Save,
> then re-run the workflow (Actions → the failed run → **Re-run jobs**).

---

## 9. First sign-in (you, as administrator)
1. Open `https://<your-project-id>.web.app` (Firebase → **Build → Hosting** shows the exact address).
2. **Create account** with the admin email from step 7.
3. Open the confirmation email Firebase sends (check spam), click the link, then press **I've confirmed** in the app.
4. You're in, with a **Users** page in the sidebar.

## 10. Move your existing data in (once)
Open **Users → Move existing data to the cloud**. Load the sources you have:

* **Old app file (.html)** — choose your latest `FACTORY_TRACK_AND_STOCK_….html`.
  This brings the master assembly list and the erection-drawing PDFs.
* **Old server data file** — `steeltrack_data.json` from the folder where `server.py` runs.
* **This browser** — the data and attachments saved on the PC you used day-to-day.
  Browsers only share saved data with the *same address*, so for this one:
  - download the built app file: repo → **Actions** → latest successful run → **Artifacts → steeltrack-cloud** → unzip → `index.html`;
  - if you used the old app by **double-clicking the file**: put this `index.html` in the same
    folder and double-click it; if you used it through **server.py** (`http://<ip>:8080`):
    put it in the server folder **as `index.html`**, restart `server.py`, open the same address;
  - sign in, **Users → Read this browser's data**.

The table shows each data set from each source with how many items it holds.
The biggest is pre-selected (usually the newest) — change it if you know better.
Press **Upload to cloud**. Anything already in the cloud is backed up first.

## 11. Bring the team in
1. Send everyone the address. Each person taps **Create account** (name, work email, password).
2. They'll see *Waiting for approval*. On your **Users** page, pick a **Quick set** or set each section, then **Approve**. Their app opens by itself.

| Quick set | Projects | Technical | Factory | Site | Office |
|---|---|---|---|---|---|
| Site engineer | View | View | View | **Edit** | — |
| Factory / QC | View | View | **Edit** | View | — |
| Technical office | View | **Edit** | View | View | — |
| Office / HR / Accounts | View | — | View | View | **Edit** |
| Manager (view all) | View | View | View | View | View |

Site pages show fabrication progress, so site staff need at least **View** on Factory.
To remove someone: **Disable** — they're locked out immediately.

**On phones:** open the address in Chrome/Safari → *Add to Home Screen* for an app icon.

## 12. Retire the old setup
Once everyone uses the web address, stop `server.py` and stop using the old file.

---

## Day-to-day
* **Status chip (bottom-right):** *Live · synced* = all good. *Saving…* = uploading.
  *Offline* = no internet; changes upload when it's back (keep the page open).
* When a teammate changes the page you're on, it refreshes by itself (never while you're typing
  or have a form open). Changes elsewhere show *tap to refresh* on the chip.
* **Backups:** Users → Backups → *Download all cloud data* any time; or restore any data set to how it was on one of the last 14 days.

## Updating the app later
Keep working on the app file the way you do now. Put the new `.html` in
`SteelTrack-Updated/` (if its name changes, update `"appSource"` in
`steeltrack.config.json`) and push. GitHub rebuilds and republishes it.
Your data is unaffected — it lives in the cloud, not in the file.

The build removes any data built into the file before publishing, and stops
with an error if project data would end up in the public page.

> **When you add a new module** that saves data under a new name, add that name to
> `KEY_SECTION` in `src/cloud/00-config.js`; otherwise its data stays on one device.

## Troubleshooting
| You see | Fix |
|---|---|
| *Cloud not set up yet* | Step 7 values missing in `steeltrack.config.json`, then push. |
| *Could not create your account record* | Rules not published yet: check the Actions run (step 8). |
| Attachments upload but won't open on another device | One-time download permission: in Firebase click the **>_** Cloud Shell icon (top right of <https://console.cloud.google.com>) and run the two lines below with your bucket name from step 7. |
| Someone can't see a page | Users page → check their access for that section. |

```
echo '[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Content-Disposition"],"maxAgeSeconds":3600}]' > cors.json
gcloud storage buckets update gs://YOUR-BUCKET-NAME --cors-file=cors.json
```
