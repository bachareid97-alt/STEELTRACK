#!/usr/bin/env python3
"""
End-to-end test of the cloud version of SteelTrack, using three real
browsers (admin, site engineer, factory user) against the local Firebase
stand-in (test/fake-server.js).

    cd test && npm install          # once
    python3 test/e2e.py             # from the repo root

Covers: sign-up + approval, bootstrap admin, per-section access (hidden /
view-only / edit), migration of the real old app file (assembly list +
erection drawings), live sync between people, merging of simultaneous
edits, the "never push empty data right after loading" guard, view-only
blocking, attachments, and teammates' changes refreshing the page.
"""
import json
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "steeltrack.config.json").read_text())
ADMIN = CFG["adminEmail"].lower()
OLD_APP = ROOT / CFG["appSource"]
def _free_port():
    import socket
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


WS_PORT, HTTP_PORT = _free_port(), _free_port()
URL = f"http://127.0.0.1:{HTTP_PORT}/public/index.html"
results, errors = [], []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS  " if cond else "FAIL  ") + name + (f"  ({detail})" if detail and not cond else ""))
    return cond


def wait_for(fn, timeout=15, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # page may be mid-reload
            last = e
        time.sleep(step)
    return None


def new_user(browser, label):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"[{label}] {e}"))
    page.on("dialog", lambda d: d.accept())
    page.add_init_script(f"window.__ST_FAKE_URL__ = 'ws://127.0.0.1:{WS_PORT}';")
    page.goto(URL)
    return page


def sign_up(page, name, email, pw="secret-123"):
    page.wait_for_selector("#stCover button.st-link:has-text('Create account')", timeout=20000)
    page.click("#stCover button.st-link:has-text('Create account')")
    page.fill("#stName", name)
    page.fill("#stEmail", email)
    page.fill("#stPass", pw)
    page.click("#stCover .st-btn-primary")


def unlocked(page):
    return page.evaluate("() => !document.documentElement.classList.contains('st-locked') && window.SteelTrackCloud.engine.isReady()")


def ev(page, js, arg=None, timeout=20):
    """page.evaluate that waits out the app refreshing itself for a teammate's change."""
    end = time.time() + timeout
    while True:
        try:
            if time.time() > end:
                return page.evaluate(js, arg)
            page.wait_for_function("() => window.SteelTrackCloud && window.SteelTrackCloud.engine.isReady()", timeout=15000)
            return page.evaluate(js, arg)
        except Exception as e:
            if "context was destroyed" not in str(e) and "navigat" not in str(e) or time.time() > end:
                raise
            time.sleep(0.5)


def click(page, sel, timeout=45):
    """Click like a person: wait until the page has finished any refresh first."""
    end = time.time() + timeout
    while True:
        try:
            page.wait_for_function("() => !document.documentElement.classList.contains('st-locked')", timeout=15000)
            page.click(sel, timeout=5000)
            return
        except Exception:
            if time.time() > end:
                raise
            time.sleep(0.7)


def ls(page, key):
    return ev(page, "k => localStorage.getItem(k)", key)


def tab_state(page, tab):
    return page.evaluate("""t => {
        const b = document.querySelector('.maintab-btn[data-maintab="'+t+'"]');
        const p = document.getElementById('maintab-'+t);
        return { hidden: !b || b.classList.contains('st-hidden'), ro: !!(p && p.classList.contains('st-ro')) };
    }""", tab)


def main():
    subprocess.run([sys.executable, str(ROOT / "tools" / "build.py"), "--test"], check=True, cwd=ROOT)
    server = subprocess.Popen(["node", str(ROOT / "test" / "fake-server.js"), str(WS_PORT), ADMIN], cwd=ROOT)
    http = subprocess.Popen([sys.executable, "-m", "http.server", str(HTTP_PORT), "--bind", "127.0.0.1"],
                            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run(browser)
            browser.close()
    finally:
        server.terminate()
        http.terminate()
    real_errors = [e for e in errors if not any(s in e for s in ("XLSX", "L is not defined", "pdfjsLib", "Leaflet"))]
    check("no JavaScript errors in the app", not real_errors, "; ".join(real_errors[:5]))
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


def run(browser):
    # ---- 1. First admin --------------------------------------------------
    admin = new_user(browser, "admin")
    admin_console = []
    admin.on("console", lambda m: admin_console.append(m.type + ": " + m.text[:160]))
    sign_up(admin, "Bachar (admin)", ADMIN)
    oka = wait_for(lambda: unlocked(admin), 25)
    if not oka:
        print("DEBUG admin cover:", admin.evaluate("() => (document.getElementById('stCover')||{}).innerText"))
        print("DEBUG admin engine:", admin.evaluate("() => JSON.stringify(window.SteelTrackCloud.engine.debugState())"))
        print("DEBUG admin console:", admin_console[-15:])
    check("admin email becomes administrator automatically", oka)
    check("live status shows connected", wait_for(lambda: "Live" in admin.inner_text("#stChip")))
    check("admin sees the Users page", not tab_state(admin, "users")["hidden"])
    check("old same-Wi-Fi sync page is hidden", tab_state(admin, "connsync")["hidden"])

    # ---- 2. Migrate the real old app file -------------------------------
    click(admin, '.maintab-btn[data-maintab="users"]')
    admin.wait_for_selector(".st-source input[type=file][accept='.html,.htm']")
    admin.set_input_files(".st-source input[type=file][accept='.html,.htm']", str(OLD_APP))
    ok = wait_for(lambda: "✔" in admin.inner_text(".st-source:nth-child(2) .st-src-status"), 60)
    check("old app file is read (assembly list + drawings)", ok, admin.inner_text(".st-source:nth-child(2) .st-src-status"))
    with admin.expect_navigation(timeout=180000):   # the page reloads itself after a successful migration
        click(admin, ".st-panel button.st-btn-primary:has-text('Upload to cloud')")
        done = wait_for(lambda: "Finished" in admin.inner_text(".st-panel:nth-child(2)"), 120)
        log = admin.inner_text(".st-panel:nth-child(2)")
    check("migration finishes without failures", done and "failed" not in log, log[-400:])
    check("migration uploads the erection-drawing PDFs", "files" in log or "file" in log.lower(), log[-200:])
    wait_for(lambda: unlocked(admin), 30)
    click(admin, '.maintab-btn[data-maintab="fab"]')
    rows = wait_for(lambda: ev(admin, "() => document.querySelectorAll('#tableBody tr').length"), 15)
    check("fabrication tracker shows the migrated assemblies", rows and rows > 5, f"rows={rows}")

    # ---- 2b. Admin backup download --------------------------------------
    click(admin, '.maintab-btn[data-maintab="users"]')
    with admin.expect_download(timeout=30000) as dl:
        click(admin, "button:has-text('Download all cloud data')")
    backup = json.loads(Path(dl.value.path()).read_text())
    check("admin can download a full backup of the cloud data",
          "steeltrack-baselist-v1" in backup and len(json.loads(backup["steeltrack-baselist-v1"])) > 100, str(list(backup)[:5]))

    # ---- 3. Site engineer signs up and is approved ----------------------
    site = new_user(browser, "site")
    site_console = []
    site.on("console", lambda m: site_console.append(m.type + ": " + m.text[:200]))
    sign_up(site, "Site Engineer", "site@example.com")
    okp = wait_for(lambda: "Waiting for approval" in site.inner_text("#stCover"), 15)
    if not okp:
        print("DEBUG site cover:", site.evaluate("() => (document.getElementById('stCover')||{}).innerHTML"))
        print("DEBUG site console:", site_console[-20:])
        print("DEBUG site session:", site.evaluate("() => localStorage.getItem('fake-auth-session')"))
        print("DEBUG site errors:", [e for e in errors if e.startswith('[site]')])
    check("new person waits for approval", okp)
    click(admin, '.maintab-btn[data-maintab="users"]')
    row = "tr:has-text('site@example.com')"
    admin.wait_for_selector(row, timeout=15000)
    admin.select_option(row + " select[title='Quick preset']", label="Site engineer")
    click(admin, row + " button:has-text('Approve')")
    check("site engineer's app opens by itself after approval", wait_for(lambda: unlocked(site), 30))
    check("site: Office pages hidden", tab_state(site, "po")["hidden"] and tab_state(site, "payments")["hidden"])
    check("site: Users page hidden", tab_state(site, "users")["hidden"])
    fab = tab_state(site, "fab")
    check("site: Fabrication visible but view-only", not fab["hidden"] and fab["ro"])
    st = tab_state(site, "site")
    check("site: Site Erection editable", not st["hidden"] and not st["ro"])
    check("site: sees the migrated assembly list", (ls(site, "steeltrack-baselist-v1") or "").startswith("[["))
    click(site, '.maintab-btn[data-maintab="fab"]')
    ev(site, "() => { window.__stay = 1; }")
    time.sleep(10)
    check("site: opening a view-only page doesn't trigger refreshes or warnings",
          ev(site, "() => window.__stay === 1 && !document.getElementById('stChip').classList.contains('attn')"))
    check("site: old full-backup export hidden for non-admins",
          ev(site, "() => { const b = document.getElementById('fullBackupBtn'); return !b || b.classList.contains('st-hidden'); }"))
    check("site: no office data copied to this device", ls(site, "purchaseorders-v1") is None)

    # ---- 4. Factory user -------------------------------------------------
    factory = new_user(browser, "factory")
    sign_up(factory, "Factory QC", "factory@example.com")
    check("factory user waits for approval", wait_for(lambda: "Waiting for approval" in factory.inner_text("#stCover"), 15),
          factory.evaluate("() => (document.getElementById('stMsg')||{}).textContent"))
    frow = "tr:has-text('factory@example.com')"
    click(admin, '.maintab-btn[data-maintab="users"]')
    admin.wait_for_selector(frow, timeout=15000)
    admin.select_option(frow + " select[title='Quick preset']", label="Factory / QC")
    click(admin, frow + " button:has-text('Approve')")
    check("factory user's app opens after approval", wait_for(lambda: unlocked(factory), 30))
    time.sleep(9)  # past the just-loaded guard window

    # ---- 5. Live sync: site edits Site data, others see it ---------------
    ev(site, """() => {
        const raw = localStorage.getItem('steeltrack-site-v1');
        const v = raw ? JSON.parse(raw) : {};
        v.__e2e = 'erected-by-site-' + 42;
        localStorage.setItem('steeltrack-site-v1', JSON.stringify(v));
    }""")
    check("site's change reaches the admin within seconds",
          wait_for(lambda: "erected-by-site-42" in (ls(admin, "steeltrack-site-v1") or ""), 10))
    check("...and the factory user", wait_for(lambda: "erected-by-site-42" in (ls(factory, "steeltrack-site-v1") or ""), 10))

    # ---- 6. View-only is enforced ----------------------------------------
    before = ls(factory, "steeltrack-overlay-v2")
    ev(site, """() => {
        const v = JSON.parse(localStorage.getItem('steeltrack-overlay-v2') || '{"edits":{},"added":[],"deletedIds":{}}');
        v.edits['1'] = { fabQty: 999 };
        localStorage.setItem('steeltrack-overlay-v2', JSON.stringify(v));
    }""")
    time.sleep(3)
    check("site's attempt to change Fabrication is not saved", ls(factory, "steeltrack-overlay-v2") == before)
    check("...and is undone on the site's device", wait_for(lambda: '"fabQty":999' not in (ls(site, "steeltrack-overlay-v2") or ""), 10))

    # ---- 7. Simultaneous edits to the same data are merged ---------------
    ev(factory, """() => {
        const v = JSON.parse(localStorage.getItem('steeltrack-overlay-v2'));
        v.edits['2'] = Object.assign({}, v.edits['2'], { fabQty: 11 });
        localStorage.setItem('steeltrack-overlay-v2', JSON.stringify(v));
    }""")
    ev(admin, """() => {
        const v = JSON.parse(localStorage.getItem('steeltrack-overlay-v2'));
        v.edits['3'] = Object.assign({}, v.edits['3'], { fabQty: 22 });
        localStorage.setItem('steeltrack-overlay-v2', JSON.stringify(v));
    }""")
    def both():
        v = json.loads(ls(site, "steeltrack-overlay-v2") or "{}")
        e = v.get("edits", {})
        return e.get("2", {}).get("fabQty") == 11 and e.get("3", {}).get("fabQty") == 22
    check("two people editing Fabrication at the same moment: both edits kept", wait_for(both, 12))

    # ---- 7b. A stale screen never undoes a teammate's change -------------
    # The factory user has a form open (so their page doesn't refresh), the
    # admin changes item 5, then the factory user's page saves its older
    # in-memory copy with their own change to item 6. Both must survive.
    stale_copy = ls(factory, "steeltrack-overlay-v2")
    ev(factory, "() => document.querySelector('.modal-overlay').classList.add('open')")
    ev(admin, """() => {
        const v = JSON.parse(localStorage.getItem('steeltrack-overlay-v2'));
        v.edits['5'] = Object.assign({}, v.edits['5'], { fabQty: 55 });
        localStorage.setItem('steeltrack-overlay-v2', JSON.stringify(v));
    }""")
    wait_for(lambda: '"fabQty":55' in (ls(factory, "steeltrack-overlay-v2") or ""), 10)
    ev(factory, """s => {
        const v = JSON.parse(s);
        v.edits['6'] = Object.assign({}, v.edits['6'], { fabQty: 66 });
        localStorage.setItem('steeltrack-overlay-v2', JSON.stringify(v));
    }""", stale_copy)
    def kept():
        e = json.loads(ls(site, "steeltrack-overlay-v2") or "{}").get("edits", {})
        return e.get("5", {}).get("fabQty") == 55 and e.get("6", {}).get("fabQty") == 66
    check("saving from an out-of-date screen keeps the teammate's newer change", wait_for(kept, 12))
    ev(factory, "() => document.querySelector('.modal-overlay.open').classList.remove('open')")

    # ---- 8. Attachments ---------------------------------------------------
    pdf = "data:application/pdf;base64," + "JVBERi0xLjQK" * 50
    ok = ev(factory, "d => window.stCloudFiles.put('steeltrack_ncr_db', 'ncr:777', d)", pdf)
    check("factory uploads an NCR attachment", ok is True)
    got = ev(site, "() => window.stCloudFiles.get('steeltrack_ncr_db', 'ncr:777')")
    check("site (Factory view-only) can open it", got == pdf)
    blocked = ev(site, "d => window.stCloudFiles.put('steeltrack_ncr_db', 'ncr:778', d)", pdf)
    check("site cannot upload into Factory", blocked is False)
    office = ev(site, "() => window.stCloudFiles.get('steeltrack_payments_db', 'po:1')")
    check("site cannot open Office files", office is None)
    jobs = ev(admin, """() => {
        const m = /id="drawingsSeed">([^<]{0,200})/.exec('');
        return Object.keys(JSON.parse(localStorage.getItem('steeltrack-baselist-v1')).reduce((a,r)=>(a[r[1]]=1,a),{}));
    }""")
    found = None
    for j in jobs[:60]:
        r = ev(site, "k => window.storage.get(k).then(x => x ? x.value.slice(0, 30) : null)", "erectionDrawing:" + j)
        if r:
            found = (j, r)
            break
    check("migrated erection drawings open on another device", found is not None, str(found))

    # ---- 8b. Through the real screens: NCR form with an AutoCAD attachment ----
    dwg = Path(__file__).resolve().parent / "_e2e_detail.dwg"
    dwg.write_bytes(b"AC1032" + bytes(range(256)) * 40)
    click(factory, '.maintab-btn[data-maintab="ncr"]')
    click(factory, "#ncrNewBtn")
    factory.fill("#ncr_f_number", "NCR-E2E-01")
    factory.fill("#ncr_f_jobOrder", "JO-3818-004")
    factory.fill("#ncr_f_description", "Weld undercut on beam B10073 (e2e)")
    factory.set_input_files("#ncr_f_file", str(dwg))
    click(factory, "#ncr_save")
    check("NCR saved through the form reaches the site engineer",
          wait_for(lambda: "NCR-E2E-01" in (ls(site, "steeltrack-ncr-v1") or ""), 15))
    time.sleep(3)   # the site was on Fabrication, so the new NCR refreshes their page; let it finish
    def open_ncr():
        ev(site, "() => document.querySelector('.maintab-btn[data-maintab=\"ncr\"]').click()")
        time.sleep(1)
        return ev(site, "() => document.querySelector('.maintab-btn.active').getAttribute('data-maintab')") == "ncr"
    wait_for(open_ncr, 20, 1)
    chip = "#maintab-ncr tr:has-text('NCR-E2E-01') [data-action='download']"
    ok = wait_for(lambda: site.is_visible(chip), 25)
    if not ok:
        print("DEBUG ncr record:", (ls(site, "steeltrack-ncr-v1") or "")[-400:])
        print("DEBUG active tab:", ev(site, "() => document.querySelector('.maintab-btn.active').getAttribute('data-maintab')"))
        print("DEBUG ncr table:", ev(site, "() => (document.querySelector('#maintab-ncr tbody')||{}).innerHTML || ''")[:600])
        print("DEBUG project:", ev(site, "() => localStorage.getItem('app-selected-project-v1')"))
    check("site sees the NCR with its attachment in the list", ok)
    if ok:
        with site.expect_download(timeout=20000) as dl:
            click(site, chip)
        path = dl.value.path()
        check("site downloads the AutoCAD file the factory attached (downloaded from the cloud)",
              Path(path).read_bytes() == dwg.read_bytes(), dl.value.suggested_filename)
    check("site's NCR page is view-only", tab_state(site, "ncr")["ro"])
    dwg.unlink()

    # ---- 9. Guard: an empty save right after loading never wipes data ----
    factory.reload()
    wait_for(lambda: unlocked(factory), 30)
    count_before = len(json.loads(ls(admin, "cncparts-v1") or "[]"))
    ev(factory, "() => localStorage.setItem('cncparts-v1', '[]')")
    time.sleep(3)
    count_after = len(json.loads(ls(admin, "cncparts-v1") or "[]"))
    check("empty save right after load is ignored", count_before == 0 or count_after == count_before,
          f"{count_before} -> {count_after}")

    # ---- 10. Teammate's change refreshes the page you're looking at ------
    click(factory, '.maintab-btn[data-maintab="fab"]')
    ev(factory, "() => { window.__marker = 1; }")
    time.sleep(5)
    ev(admin, """() => {
        const v = JSON.parse(localStorage.getItem('steeltrack-overlay-v2'));
        v.edits['4'] = Object.assign({}, v.edits['4'], { fabQty: 33 });
        localStorage.setItem('steeltrack-overlay-v2', JSON.stringify(v));
    }""")
    reloaded = wait_for(lambda: ev(factory, "() => window.__marker === undefined") and unlocked(factory), 20)
    check("factory page refreshes after a teammate edits Fabrication", reloaded)
    check("...and comes back to the Fabrication page",
          wait_for(lambda: ev(factory, "() => (document.querySelector('.maintab-btn.active')||{}).getAttribute && document.querySelector('.maintab-btn.active').getAttribute('data-maintab')") == "fab", 8))

    # ---- 11. Access changes apply immediately ----------------------------
    click(admin, '.maintab-btn[data-maintab="users"]')
    admin.wait_for_selector(row)
    admin.select_option(row + " td:nth-child(7) select", "none")   # Factory column
    click(admin, row + " button:has-text('Save')")
    check("removing site's Factory access hides it for them",
          wait_for(lambda: unlocked(site) and tab_state(site, "fab")["hidden"], 25))
    click(admin, row + " button:has-text('Disable')")
    check("disabled account is locked out", wait_for(lambda: "Account disabled" in site.inner_text("#stCover"), 25))

    # ---- 12. Sign out clears this computer's copy ------------------------
    click(factory, "#stChip")
    click(factory, "#stMenu button:has-text('Sign out')")
    wait_for(lambda: factory.is_visible("#stCover #stEmail"), 15)
    check("signing out removes the team's data from the device",
          factory.evaluate("() => localStorage.getItem('steeltrack-overlay-v2')") is None)


if __name__ == "__main__":
    main()
