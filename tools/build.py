#!/usr/bin/env python3
"""
Builds the cloud version of SteelTrack.

Takes the normal app file (the FACTORY_TRACK_AND_STOCK .html you keep
updating) and produces public/index.html for Firebase Hosting:

  * adds the cloud layer (personal logins, live team sync, permissions,
    cloud file storage) from src/cloud/
  * removes the old access-code login, the old same-Wi-Fi sync and the
    unused old Firebase block
  * REMOVES all project data that was built into the page (assembly list,
    drawings, part lists...). The hosted page is public, so the data must
    only live in the locked cloud database. Use the migration tool on the
    Users page to move that data into the cloud.
  * makes every module's attachments also upload to cloud storage
  * fills in the security rules with your admin email -> build/

Usage:
    python3 tools/build.py            # normal build
    python3 tools/build.py --test     # build for the local test stand-in
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "steeltrack.config.json"
CLOUD_DIR = ROOT / "src" / "cloud"
OUT = ROOT / "public"
BUILD = ROOT / "build"
SDK = "https://www.gstatic.com/firebasejs/10.14.1/"
SDK_FILES = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-database-compat.js",
             "firebase-firestore-compat.js", "firebase-storage-compat.js"]
ATTACH_TYPES = ".pdf,image/*,.dwg,.dxf,.ifc,.xlsx,.xls,.csv,.doc,.docx,.zip,.rar"


class BuildError(Exception):
    pass


def must_find(html, needle, what):
    i = html.find(needle)
    if i < 0:
        raise BuildError(f"Could not find {what} in the app file (looked for: {needle[:60]!r}). "
                         f"The app file has changed shape - update tools/build.py.")
    return i


def remove_script_containing(html, marker, what):
    """Remove the whole <script>...</script> element that contains `marker`."""
    i = html.find(marker)
    if i < 0:
        return html, False
    start = html.rfind("<script", 0, i)
    end = html.find("</script>", i)
    if start < 0 or end < 0:
        raise BuildError(f"Could not cut out {what}")
    return html[:start] + f"<!-- {what}: removed by tools/build.py (replaced by SteelTrack Cloud) -->" + html[end + 9:], True


def strip_embedded_data(html, report):
    """Empty every <script type="application/json" id=...> data block."""
    def repl(m):
        tag, body = m.group(1), m.group(2)
        ident = re.search(r'id="([^"]+)"', tag).group(1)
        b = body.strip()
        empty = "{}" if b.startswith("{") else "[]" if b.startswith("[") else '""'
        if len(body) > 2:
            report.append(f"  emptied built-in data '{ident}' ({len(body):,} bytes)")
        return f"{tag}{empty}</script>"
    # Real data blocks only: a plain id, and the tag at the start of a line
    # (the app's JavaScript also builds strings like '<script ... id="' + id + '">').
    return re.sub(r'(?m)^(\s*<script type="application/json" id="[A-Za-z0-9_-]+">)([\s\S]*?)</script>', repl, html)


JO_RE = re.compile(r"JO-\d{4}-\d{3}")
DATA_TERMS = set()   # project names / job orders taken from the file's own data


def collect_data_terms(html):
    """Remember the project names and job orders in the app's built-in data,
    so drop-downs listing them can be recognised and emptied."""
    DATA_TERMS.clear()
    m = re.search(r'<script type="application/json" id="seedData">([\s\S]*?)</script>', html)
    if not m:
        return
    try:
        rows = json.loads(m.group(1))
    except ValueError:
        return
    for r in rows:
        for v in (r[1], r[2], r[7]):   # job order, project, profile
            if isinstance(v, str) and len(v.strip()) >= 4:
                DATA_TERMS.add(v.strip())


def looks_like_data(inner):
    if JO_RE.search(inner):
        return True
    for opt in re.findall(r"<option[^>]*>([^<]*)</option>", inner):
        if opt.strip() in DATA_TERMS:
            return True
    return False


def _body_end(html, start, tag):
    """Index of the </tag> that closes the element opened at `start` (handles nesting)."""
    depth, i = 0, start
    open_re = re.compile(r"<%s\b|</%s>" % (tag, tag))
    for m in open_re.finditer(html, start):
        if m.group(0).startswith("</"):
            depth -= 1
            if depth == 0:
                return m.start()
        else:
            depth += 1
    raise BuildError(f"Unclosed <{tag}> at {start}")


def outside_scripts(html, fn):
    """Apply fn(segment) only to the HTML between <script>...</script> blocks,
    so markup-looking text inside the app's JavaScript is never touched."""
    parts, pos = [], 0
    for m in re.finditer(r"<script\b[^>]*>[\s\S]*?</script>", html):
        parts.append(fn(html[pos:m.start()]))
        parts.append(m.group(0))
        pos = m.end()
    parts.append(fn(html[pos:]))
    return "".join(parts)


FULL_HTML = [""]


def strip_prerendered(html, report):
    FULL_HTML[0] = html
    totals = {"tbody": 0, "datalist": 0, "select": 0, "ul": 0, "div": 0, "bytes": 0}

    def seg_fn(seg):
        r = []
        out = _strip_segment(seg, r)
        for k, v in r[0].items():
            totals[k] += v
        return out
    html = outside_scripts(html, seg_fn)
    report.append(f"  emptied snapshot data: {totals['tbody']} tables, {totals['datalist'] + totals['ul']} lists, "
                  f"{totals['select']} drop-downs, {totals['div']} panels ({totals['bytes']:,} bytes)")
    # Desktop app file path shown as a tooltip
    return re.sub(r'(id="syncedLabel")\s+title="[^"]*"', r'\1', html)


def _strip_segment(html, report):
    """The app file is a snapshot of the running app, so its tables, lists
    and drop-downs still hold whatever data they were showing. The app
    redraws all of them from the live data when it runs, so empty them:
      - every <tbody> and <datalist>
      - drop-downs filled with job orders: keep only the first ("All") option
      - other containers (charts, groups) holding job-order data"""
    counts = {"tbody": 0, "datalist": 0, "select": 0, "ul": 0, "div": 0}
    removed = 0

    def empty_elements(html, tag, keep_first_option=False, only_if_data=False):
        nonlocal removed
        out, pos = [], 0
        for m in re.finditer(r"<%s\b[^>]*>" % tag, html):
            if m.start() < pos:
                continue
            inner_start = m.end()
            inner_end = _body_end(html, m.start(), tag)
            inner = html[inner_start:inner_end]
            if not inner.strip() or (only_if_data and not looks_like_data(inner)):
                continue
            keep = ""
            if keep_first_option:
                first = re.match(r"\s*(<option\b[^>]*>[^<]*</option>)", inner)
                if first and not JO_RE.search(first.group(1)):
                    keep = first.group(1)
            out.append(html[pos:inner_start] + keep)
            removed += len(inner) - len(keep)
            counts[tag] += 1
            pos = inner_end
        out.append(html[pos:])
        return "".join(out)

    html = empty_elements(html, "tbody")
    html = empty_elements(html, "datalist")
    html = empty_elements(html, "select", keep_first_option=True, only_if_data=True)
    html = empty_elements(html, "ul", only_if_data=True)
    # Containers like the job-order chart / project groups (only ones with an
    # id and holding job-order data; outermost first so nesting is handled).
    for m in list(re.finditer(r'<div\b[^>]*\bid="([^"]+)"[^>]*>', html))[::-1]:
        start = m.end()
        try:
            end = _body_end(html, m.start(), "div")
        except BuildError:
            continue
        inner = html[start:end]
        # Only containers the app redraws itself (referenced by id in its
        # code) and that hold no named elements of their own.
        ident = m.group(1)
        redrawn = ("getElementById('%s')" % ident) in FULL_HTML[0] or ('getElementById("%s")' % ident) in FULL_HTML[0]
        if len(JO_RE.findall(inner)) >= 3 and redrawn and " id=" not in inner and "<script" not in inner:
            html = html[:start] + html[end:]
            removed += len(inner)
            counts["div"] += 1
    counts["bytes"] = removed
    report.append(counts)
    return html


WRAPPERS = {
    "idbSet": ("function idbSet(key, value){"
               " var up = window.stCloudFiles ? window.stCloudFiles.put(DB_NAME, key, value) : Promise.resolve(false);"
               " return idbSetLocal(key, value).catch(function(err){ return up.then(function(ok){ if(ok) return true; throw err; }); }); }"),
    "idbGet": ("function idbGet(key){"
               " return idbGetLocal(key).catch(function(){ return null; }).then(function(v){"
               " if(v || !window.stCloudFiles) return v;"
               " return window.stCloudFiles.get(DB_NAME, key).then(function(cv){ if(cv){ idbSetLocal(key, cv).catch(function(){}); } return cv; }); }); }"),
    "idbDelete": ("function idbDelete(key){"
                  " if(window.stCloudFiles) window.stCloudFiles.del(DB_NAME, key);"
                  " return idbDeleteLocal(key); }"),
}


def patch_file_stores(html, report):
    """In every module that keeps attachments in its own browser file store,
    route saves/reads through the cloud as well."""
    decl = re.compile(r"var DB_NAME\s*=\s*'([a-z_]+)'")
    matches = list(decl.finditer(html))
    if not matches:
        raise BuildError("No module file stores (var DB_NAME = ...) found")
    out, pos = [], 0
    patched = []
    for idx, m in enumerate(matches):
        seg_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(html)
        segment = html[m.start():seg_end]
        out.append(html[pos:m.start()])
        db = m.group(1)
        store = re.search(r"STORE_NAME\s*=\s*'([a-z_]+)'", segment[:400])
        store = store.group(1) if store else "files"
        if store != "files":
            # The erection-drawing viewer already uses window.storage, which
            # the cloud layer provides.
            out.append(segment)
            pos = seg_end
            continue
        present = [fn for fn in WRAPPERS if re.search(r"function %s\(" % fn, segment)]
        if "idbSet" not in present or "idbGet" not in present:
            raise BuildError(f"File store {db} doesn't have the expected idbSet/idbGet functions")
        for fn in present:
            segment, n = re.subn(r"function %s\(" % fn, "function %sLocal(" % fn, segment)
            if n != 1:
                raise BuildError(f"Expected exactly one {fn} in {db}, found {n}")
        line_end = segment.find("\n")
        wrappers = "\n  " + "\n  ".join(WRAPPERS[fn] for fn in present) + "\n"
        segment = segment[:line_end] + wrappers + segment[line_end:]
        patched.append(db)
        out.append(segment)
        pos = seg_end
    out.append(html[pos:])
    report.append(f"  attachments now upload to the cloud for: {', '.join(patched)}")
    return "".join(out)


def widen_attachment_types(html, report):
    n1 = html.count('accept=".pdf,image/*"')
    html = html.replace('accept=".pdf,image/*"', f'accept="{ATTACH_TYPES}"')
    n2 = len(re.findall(r'id="ni_f_file" type="file" accept="\.zip"', html))
    html = re.sub(r'(id="ni_f_file" type="file" accept=)"\.zip"', r'\1"%s"' % ATTACH_TYPES, html)
    n3 = len(re.findall(r"input\.accept\s*=\s*'\.pdf,image/\*'", html))
    html = re.sub(r"(input\.accept\s*=\s*)'\.pdf,image/\*'", r"\1'%s'" % ATTACH_TYPES, html)
    report.append(f"  {n1 + n2 + n3} attachment pickers now accept PDF, images, AutoCAD (DWG/DXF), IFC, Excel, Word, ZIP")
    return html


def cloud_block(cfg, test):
    css = (CLOUD_DIR / "cloud.css").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in sorted(CLOUD_DIR.glob("*.js")))
    client_cfg = {"firebase": cfg.get("firebase", {}), "adminEmail": cfg.get("adminEmail", "")}
    parts = ["<!-- ===================== SteelTrack Cloud (src/cloud, added by tools/build.py) ===================== -->",
             "<style>\n" + css + "\n</style>",
             "<script>window.STEELTRACK_CLOUD_CONFIG = " + json.dumps(client_cfg) + ";</script>"]
    if test:
        parts.append('<script src="/test/fake-backend.js"></script>')
    else:
        parts += [f'<script src="{SDK}{f}"></script>' for f in SDK_FILES]
    parts.append("<script>\n" + js.replace("</script", "<\\/script") + "\n</script>")
    parts.append("<!-- =================== /SteelTrack Cloud =================== -->")
    return "\n".join(parts)


BASELIST_FILLER = ("<script>/* SteelTrack Cloud: the master assembly list now lives in the cloud; "
                   "use this device's synced copy */(function(){try{var c=localStorage.getItem('steeltrack-baselist-v1');"
                   "if(c){document.getElementById('seedData').textContent=c;}}catch(e){}})();</script>")


def transform(html, cfg, test, report):
    # 1. Old same-Wi-Fi sync -> cloud layer (must run before the app's own code)
    marker = "<!--LAN_SYNC_SERVER_CONFIG-->"
    i = html.find(marker)
    if i >= 0:
        end = html.find("</script>", i)
        html = html[:i] + cloud_block(cfg, test) + html[end + 9:]
        report.append("  replaced the same-Wi-Fi sync with the cloud layer")
    else:
        i = must_find(html, "</head>", "</head>")
        html = html[:i] + cloud_block(cfg, test) + "\n" + html[i:]
        report.append("  added the cloud layer")

    # 2. Unused old Firebase block
    m = re.search(r"<!-- =+\s*LIVE SYNC ACROSS DESKTOPS[\s\S]*?waitFirebase[\s\S]*?</script>", html)
    if m:
        html = html[:m.start()] + "<!-- old Firebase sync removed by tools/build.py -->" + html[m.end():]
        report.append("  removed the old (never configured) Firebase block")

    # 3. Old shared access codes (anyone could read them in the page source)
    html, done = remove_script_containing(html, "var ACCESS_CODES", "old access-code login")
    if done:
        report.append("  removed the old shared access codes")

    # 4. Built-in data -> nothing (it lives in the cloud now)
    collect_data_terms(html)
    html = strip_embedded_data(html, report)
    html = strip_prerendered(html, report)
    i = must_find(html, '<script type="application/json" id="seedData">', "the assembly list block")
    j = html.find("</script>", i) + 9
    html = html[:j] + BASELIST_FILLER + html[j:]

    # 5. Attachments -> cloud
    html = patch_file_stores(html, report)
    html = widen_attachment_types(html, report)

    html = html.replace("<title>SteelTrack — Fabrication &amp; Stock Control</title>",
                        "<title>SteelTrack — Fabrication &amp; Stock Control</title>\n<meta name=\"robots\" content=\"noindex\">")
    return html


def check_no_data_left(html):
    """Fail the build if obvious project data is still in the public page."""
    leaks = []
    big = [ln for ln in html.split("\n") if len(ln) > 150_000]
    if big:
        leaks.append(f"{len(big)} very long line(s) remain (first starts: {big[0][:80]!r})")
    if re.search(r"data:application/pdf;base64,", html):
        leaks.append("an embedded PDF is still in the page")
    jo = len(re.findall(r"JO-\d{4}-\d{3}", html))
    if jo > 40:
        leaks.append(f"{jo} job-order numbers still in the page")
    markup = []
    outside_scripts(html, lambda seg: markup.append(seg) or seg)
    markup = "".join(markup)
    found = sorted(t for t in DATA_TERMS if not JO_RE.fullmatch(t) and markup.count(">" + t + "<") > 0)
    if found:
        leaks.append(f"{len(found)} project name(s) still in the page, e.g. {found[:3]}")
    if leaks:
        raise BuildError("Project data may still be inside the public page:\n  - " + "\n  - ".join(leaks))


def render_rules(cfg):
    admin = cfg.get("adminEmail", "").strip().lower()
    if not re.fullmatch(r"[^@\s\"'\\]+@[^@\s\"'\\]+\.[^@\s\"'\\]+", admin):
        raise BuildError("Set a valid \"adminEmail\" in steeltrack.config.json (the first administrator's email).")
    (BUILD / "rules").mkdir(parents=True, exist_ok=True)
    for name in ("database.rules.json", "firestore.rules", "storage.rules"):
        src = (ROOT / "rules" / name).read_text(encoding="utf-8")
        (BUILD / "rules" / name).write_text(src.replace("__ADMIN_EMAIL__", admin), encoding="utf-8")


def main():
    test = "--test" in sys.argv
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    src = ROOT / cfg["appSource"]
    html = src.read_text(encoding="utf-8")
    report = [f"Building from {cfg['appSource']} ({len(html):,} bytes)"]
    html = transform(html, cfg, test, report)
    check_no_data_left(html)
    OUT.mkdir(exist_ok=True)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    # "Add to Home Screen" support the page links to
    (OUT / "manifest.json").write_text(json.dumps({
        "name": "SteelTrack", "short_name": "SteelTrack", "start_url": "/", "display": "standalone",
        "background_color": "#0a0e17", "theme_color": "#0d1424"}), encoding="utf-8")
    (OUT / "sw.js").write_text("// SteelTrack: no offline cache (data comes live from the cloud)\n", encoding="utf-8")
    report.append(f"Wrote public/index.html ({len(html):,} bytes)")
    if test:
        report.append("TEST build: uses the local stand-in backend, not Firebase")
    else:
        render_rules(cfg)
        report.append("Wrote build/rules/ (admin: %s)" % cfg["adminEmail"])
        fb = cfg.get("firebase", {})
        if not fb.get("apiKey") or str(fb.get("apiKey")).startswith("PASTE"):
            report.append("WARNING: Firebase settings not filled in yet - the page will say 'Cloud not set up yet'.")
    print("\n".join(report))


if __name__ == "__main__":
    try:
        main()
    except BuildError as e:
        print("BUILD FAILED: " + str(e), file=sys.stderr)
        sys.exit(1)
