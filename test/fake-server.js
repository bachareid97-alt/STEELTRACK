// Test stand-in for Firebase (auth + Realtime Database + Storage), used only
// by test/e2e.py. It enforces the same access rules as rules/*.rules so the
// app's permission handling can be tested without the real Firebase.
//   node test/fake-server.js <port> <adminEmail>
const { WebSocketServer } = require('ws');
const port = +process.argv[2] || 8790;
const ADMIN = (process.argv[3] || 'admin@test.local').toLowerCase();

let root = {};
const accounts = {};   // email -> { uid, pw, verified }
const files = {};      // path -> { data, meta }
const subs = new Set(); // { ws, path, id }
let uidSeq = 1;

const SECTIONS = ['projects', 'technical', 'factory', 'site', 'office'];
const split = p => String(p || '').split('/').filter(Boolean);
function getAt(path) { let n = root; for (const s of split(path)) { if (n == null || typeof n !== 'object') return null; n = n[s]; } return n === undefined ? null : n; }
function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v)) { const c = clean(v[k]); if (c !== null) o[k] = c; }
  return Object.keys(o).length ? o : null;
}
function setAt(path, val) {
  const segs = split(path);
  val = clean(JSON.parse(JSON.stringify(val === undefined ? null : val)));
  if (!segs.length) { root = val || {}; return; }
  let n = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (n[segs[i]] == null || typeof n[segs[i]] !== 'object') n[segs[i]] = {};
    n = n[segs[i]];
  }
  if (val === null) delete n[segs[segs.length - 1]]; else n[segs[segs.length - 1]] = val;
  root = clean(root) || {};
}
// Like the real database: objects with integer keys come back as arrays.
function rtdbView(v) {
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  const out = {};
  for (const k of keys) out[k] = rtdbView(v[k]);
  if (keys.length && keys.every(k => /^(0|[1-9]\d*)$/.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (keys.length * 2 > max) { const a = new Array(max + 1).fill(null); for (const k of keys) a[+k] = out[k]; return a; }
  }
  return out;
}

// ---- access rules (mirror rules/database.rules.json) ----
function prof(u) { return u ? getAt('users/' + u.uid) : null; }
function bootAdmin(u) { return !!u && u.email === ADMIN && u.verified; }
function active(u) { const p = prof(u); return !!p && p.approved === true && p.disabled !== true; }
function isAdmin(u) { if (bootAdmin(u)) return true; const p = prof(u); return active(u) && p.admin === true; }
function level(u, s) { if (isAdmin(u)) return 'edit'; if (!active(u)) return 'none'; const l = ((prof(u) || {}).perms || {})[s]; return l === 'view' || l === 'edit' ? l : 'none'; }
function canRead(u, path) {
  const s = split(path);
  if (!u) return false;
  if (s[0] === 'users') return s.length === 1 ? isAdmin(u) : (s[1] === u.uid || isAdmin(u));
  if (s[0] === 'data') {
    if (s.length < 3) return isAdmin(u);   // whole data folder: admins only
    if (s[1] === 'common') return bootAdmin(u) || active(u);
    return SECTIONS.includes(s[1]) && level(u, s[1]) !== 'none';
  }
  if (s[0] === 'backups' || s[0] === 'backupDays') return isAdmin(u);
  return false;
}
function canWrite(u, path, val) {
  const s = split(path);
  if (!u) return false;
  if (s[0] === 'users') {
    if (s.length < 2) return false;
    if (isAdmin(u)) return true;
    return s.length === 2 && s[1] === u.uid && getAt(path) === null && val && val.approved === false && val.admin === false && !val.perms && val.email === u.email;
  }
  if (s[0] === 'data') {
    if (s.length < 3) return false;
    if (s[1] === 'common') return bootAdmin(u) || active(u);
    return SECTIONS.includes(s[1]) && level(u, s[1]) === 'edit';
  }
  if (s[0] === 'backups') {
    if (isAdmin(u)) return true;
    return s.length === 4 && getAt(path) === null && val !== null && active(u) && (s[2] === 'common' || ((prof(u).perms || {})[s[2]] === 'edit'));
  }
  if (s[0] === 'backupDays') return isAdmin(u) || (s.length === 2 && val === true && active(u));
  return false;
}
function fileSection(path) { const s = split(path); return s[0] === 'files' && SECTIONS.includes(s[1]) ? s[1] : null; }

function notify(changedPaths) {
  for (const sub of subs) {
    const hit = changedPaths.some(p => p === sub.path || p.startsWith(sub.path + '/') || sub.path.startsWith(p + '/') || p === '');
    if (!hit) continue;
    if (!canRead(sub.ws.user, sub.path)) { send(sub.ws, { ev: 'error', sub: sub.id, error: 'PERMISSION_DENIED' }); continue; }
    send(sub.ws, { ev: 'value', sub: sub.id, val: rtdbView(getAt(sub.path)) });
  }
}
function send(ws, m) { try { ws.send(JSON.stringify(m)); } catch (e) {} }
const deny = () => { const e = new Error('PERMISSION_DENIED: Permission denied'); e.code = 'PERMISSION_DENIED'; throw e; };

const handlers = {
  signUp(ws, { email, pw }) {
    email = email.toLowerCase();
    if (accounts[email]) { const e = new Error('exists'); e.code = 'auth/email-already-in-use'; throw e; }
    accounts[email] = { uid: 'u' + (uidSeq++), pw, verified: email === ADMIN }; // test: admin's email counts as confirmed
    ws.user = { uid: accounts[email].uid, email, verified: accounts[email].verified };
    return ws.user;
  },
  signIn(ws, { email, pw }) {
    email = email.toLowerCase();
    const a = accounts[email];
    if (!a || a.pw !== pw) { const e = new Error('bad'); e.code = 'auth/invalid-credential'; throw e; }
    ws.user = { uid: a.uid, email, verified: a.verified };
    return ws.user;
  },
  signOut(ws) { ws.user = null; return true; },
  get(ws, { path }) { if (!canRead(ws.user, path)) deny(); return rtdbView(getAt(path)); },
  set(ws, { path, val }) { if (!canWrite(ws.user, path, val)) deny(); setAt(path, val); notify([split(path).join('/')]); return true; },
  update(ws, { map }) {
    const paths = Object.keys(map);
    for (const p of paths) if (!canWrite(ws.user, p, map[p])) deny();
    for (const p of paths) setAt(p, map[p]);
    notify(paths.map(p => split(p).join('/')));
    return true;
  },
  sub(ws, { path, sub }) {
    const s = { ws, path: split(path).join('/'), id: sub };
    if (!canRead(ws.user, path)) { send(ws, { ev: 'error', sub, error: 'PERMISSION_DENIED' }); return true; }
    subs.add(s);
    send(ws, { ev: 'value', sub, val: rtdbView(getAt(path)) });
    return true;
  },
  unsub(ws, { sub }) { for (const s of subs) if (s.ws === ws && s.id === sub) subs.delete(s); return true; },
  putFile(ws, { path, data, meta }) {
    const sec = fileSection(path);
    if (!sec || level(ws.user, sec) !== 'edit') deny();
    files[path] = { data, meta };
    return true;
  },
  getFile(ws, { path }) {
    const sec = fileSection(path);
    if (!sec || level(ws.user, sec) === 'none') deny();
    return files[path] ? files[path].data : null;
  },
  delFile(ws, { path }) {
    const sec = fileSection(path);
    if (!sec || level(ws.user, sec) !== 'edit') deny();
    delete files[path];
    return true;
  },
  // test helpers
  __dump() { return { root, files: Object.keys(files) }; },
  __verify(ws, { email }) { accounts[email].verified = true; return true; }
};

const wss = new WebSocketServer({ port });
wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try { send(ws, { id: m.id, ok: true, result: handlers[m.op](ws, m) }); }
    catch (e) { send(ws, { id: m.id, ok: false, error: e.message, code: e.code }); }
  });
  ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
});
console.log('fake firebase on ' + port + ' admin=' + ADMIN);
