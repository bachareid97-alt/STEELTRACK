// Unit tests for src/cloud/10-codec.js:  node test/codec.test.js
global.window = {};
require('../src/cloud/10-codec.js');
const C = window.SteelTrackCloud.codec;
const assert = require('assert');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

// emulate the database: objects with integer keys may come back as arrays
function viaDb(v){
  v = JSON.parse(JSON.stringify(v));
  (function walk(o){
    if(!o || typeof o !== 'object') return o;
    for(const k of Object.keys(o)) o[k] = walk(o[k]);
    const ks = Object.keys(o);
    if(!Array.isArray(o) && ks.length && ks.every(k=>/^\d+$/.test(k))){ const a=[]; ks.forEach(k=>a[+k]=o[k]); return a; }
    return o;
  })(v);
  return v;
}
const big = { edits: {}, added: [], deletedIds: {} };
for(let i=1;i<=3000;i++) big.edits[i] = { fabQty: i % 5, fabDate: '2026-08-' + String(1 + i % 28).padStart(2,'0') };
for(let i=0;i<500;i++) big.added.push({ id: 5000+i, jobOrder: 'JO-3818-0' + (i%90), name: 'Item.with.dots #' + i, '/weird[key]': i });
const raw = JSON.stringify(big);

t('round trip of a large value', () => {
  const node = C.rawToNode(raw, null);
  assert.ok(typeof node === 'object', 'large value is split');
  assert.ok(C.rawEqual(C.nodeToRaw(viaDb(node)), raw));
});
t('non-JSON strings survive', () => {
  assert.strictEqual(C.nodeToRaw(C.rawToNode('plain text', null)), 'plain text');
});
t('a one-cell edit produces a tiny diff', () => {
  const a = C.rawToNode(raw, null);
  const v = JSON.parse(raw); v.edits['1234'].fabQty = 99;
  const b = C.rawToNode(JSON.stringify(v), a);
  const d = C.diff(a, b);
  assert.strictEqual(Object.keys(d).length, 1);
  assert.ok(JSON.stringify(d).length < 200, 'diff is small: ' + JSON.stringify(d).length);
  assert.ok(C.rawEqual(C.nodeToRaw(C.patch(viaDb(a), d)), JSON.stringify(v)));
});
t('appending to and deleting from arrays', () => {
  const a = C.rawToNode(raw, null);
  const v = JSON.parse(raw); v.added.push({ id: 1, x: 'new' }); v.added.splice(10, 1);
  const b = C.rawToNode(JSON.stringify(v), a);
  const out = C.patch(viaDb(a), C.diff(a, b));
  assert.ok(C.rawEqual(C.nodeToRaw(out), JSON.stringify(v)));
});
t('two people editing different items at once are merged', () => {
  const base = C.rawToNode(raw, null);
  const mine = JSON.parse(raw); mine.edits['10'].fabQty = 7;              // factory
  const theirs = JSON.parse(raw); theirs.edits['20'].fabQty = 8; theirs.added.push({id:9999}); // someone else
  const theirsNode = viaDb(C.patch(base, C.diff(base, C.rawToNode(JSON.stringify(theirs), base))));
  const ours = C.diff(base, C.rawToNode(JSON.stringify(mine), base));
  const merged = JSON.parse(C.nodeToRaw(C.patch(theirsNode, ours)));
  assert.strictEqual(merged.edits['10'].fabQty, 7);
  assert.strictEqual(merged.edits['20'].fabQty, 8);
  assert.strictEqual(merged.added[merged.added.length-1].id, 9999);
});
t('shrinking a split value to small turns it back into one leaf', () => {
  const a = C.rawToNode(raw, null);
  const b = C.rawToNode('{"edits":{},"added":[],"deletedIds":{}}', a);
  const out = C.patch(viaDb(a), C.diff(a, b));
  assert.deepStrictEqual(JSON.parse(C.nodeToRaw(out)), { edits:{}, added:[], deletedIds:{} });
});
t('empty detection', () => {
  ['[]','{}','','{"edits":{},"added":[],"deletedIds":{}}','{"items":[],"log":[]}'].forEach(s => assert.ok(C.isEmptyRaw(s), s));
  ['[1]','{"items":[1],"log":[]}'].forEach(s => assert.ok(!C.isEmptyRaw(s), s));
});
t('database-unsafe keys are encoded and decoded', () => {
  ['a.b', 'x/y', '#$[]', '', '%41', 'ok'].forEach(k => {
    const e = C.encSeg(k); assert.ok(!/[.#$\[\]\/]/.test(e) && e.length > 0, e); assert.strictEqual(C.decSeg(e), k);
  });
});
t('key order differences are not treated as changes', () => {
  assert.ok(C.rawEqual('{"a":1,"b":[1,2]}', '{"b":[1,2],"a":1}'));
  assert.ok(!C.rawEqual('{"a":1}', '{"a":2}'));
});
console.log(n + ' codec tests passed');
