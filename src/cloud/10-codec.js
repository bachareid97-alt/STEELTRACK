/* =====================================================================
   SteelTrack Cloud — data encoding and diffing
   ---------------------------------------------------------------------
   Each saved key is a big JSON string (e.g. the whole fabrication
   overlay). Sending the whole string on every edit would re-download
   megabytes to every teammate for a one-cell change, so instead the
   value is stored as a tree: large objects/arrays are split into child
   nodes, small parts are stored as JSON text leaves. An edit then only
   writes (and only re-sends to teammates) the few leaves that changed.

   Node format (as stored in the Realtime Database):
     "J<json>"            leaf holding any JSON value
     "S<text>"            leaf holding a raw (non-JSON) string value
     { t:'a', n:<len>, c:{ "<index>": node, ... } }   array branch
     { t:'o',          c:{ "<encodedKey>": node, ... } }  object branch
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};
  var SPLIT = 6000;      // values bigger than this (as JSON) get split
  var MAX_DEPTH = 8;

  // Realtime Database keys can't contain . # $ [ ] / or control chars,
  // and can't be empty. Encode those (and % itself) as %XX.
  function encSeg(s){
    s = String(s);
    if(s === '') return '%00';
    return s.replace(/[%.#$\[\]\/\x00-\x1f\x7f]/g, function(c){
      var h = c.charCodeAt(0).toString(16).toUpperCase();
      return '%' + (h.length < 2 ? '0' + h : h);
    });
  }
  function decSeg(s){
    if(s === '%00') return '';
    return String(s).replace(/%([0-9A-F]{2})/g, function(m, h){ return String.fromCharCode(parseInt(h, 16)); });
  }

  function isBranch(n){ return !!n && typeof n === 'object'; }
  function childKeys(c){
    if(!c) return [];
    return Object.keys(c).filter(function(k){ return c[k] !== null && c[k] !== undefined; });
  }

  // value -> node. prev (the node currently in the cloud for this spot)
  // keeps an existing branch as a branch unless it shrinks a lot, so a
  // value hovering around the split size doesn't flip back and forth.
  function toNode(v, depth, prev){
    depth = depth || 0;
    var s = JSON.stringify(v);
    if(s === undefined) s = 'null';
    if(!v || typeof v !== 'object' || depth >= MAX_DEPTH) return 'J' + s;
    var wasBranch = isBranch(prev);
    var big = s.length > SPLIT || (wasBranch && s.length > SPLIT / 3);
    if(!big) return 'J' + s;
    var isArr = Array.isArray(v);
    var keys = isArr ? null : Object.keys(v);
    if(isArr ? v.length === 0 : keys.length === 0) return 'J' + s;
    var prevC = wasBranch ? prev.c : null;
    var node = { t: isArr ? 'a' : 'o', c: {} };
    if(isArr){
      node.n = v.length;
      for(var i=0;i<v.length;i++){
        var ek = String(i);
        node.c[ek] = toNode(v[i] === undefined ? null : v[i], depth + 1, prevC ? prevC[ek] : null);
      }
    } else {
      keys.forEach(function(k){
        if(v[k] === undefined) return;
        var ek = encSeg(k);
        node.c[ek] = toNode(v[k], depth + 1, prevC ? prevC[ek] : null);
      });
    }
    return node;
  }

  function fromNode(n){
    if(n === null || n === undefined) return null;
    if(typeof n === 'string'){
      if(n.charAt(0) === 'J') return JSON.parse(n.slice(1));
      if(n.charAt(0) === 'S') return n.slice(1);
      return n;
    }
    var c = n.c || {};
    if(n.t === 'a'){
      var len = typeof n.n === 'number' ? n.n : 0;
      var arr = new Array(len);
      childKeys(c).forEach(function(k){
        var i = parseInt(k, 10);
        if(i >= arr.length) arr.length = i + 1;
        arr[i] = fromNode(c[k]);
      });
      for(var j=0;j<arr.length;j++) if(arr[j] === undefined) arr[j] = null;
      return arr;
    }
    var obj = {};
    childKeys(c).forEach(function(k){ obj[decSeg(k)] = fromNode(c[k]); });
    return obj;
  }

  // A whole saved value (the raw localStorage string) <-> its top node.
  function rawToNode(raw, prev){
    if(raw === null || raw === undefined) return null;
    var parsed;
    try{ parsed = JSON.parse(raw); }catch(e){ return 'S' + raw; }
    return toNode(parsed, 0, prev);
  }
  function nodeToRaw(node){
    if(node === null || node === undefined) return null;
    if(typeof node === 'string' && node.charAt(0) === 'S') return node.slice(1);
    return JSON.stringify(fromNode(node));
  }

  // Minimal set of writes turning node `a` into node `b`, as
  // { "relative/path": newNodeOrNull }. Paths are relative to the node.
  function diff(a, b, path, out){
    out = out || {};
    path = path || '';
    var p = function(seg){ return path ? path + '/' + seg : seg; };
    if(a === null || a === undefined){ if(b !== null && b !== undefined) out[path] = b; return out; }
    if(b === null || b === undefined){ out[path] = null; return out; }
    if(!isBranch(a) || !isBranch(b) || a.t !== b.t){
      if(!nodesEqual(a, b)) out[path] = b;
      return out;
    }
    if(b.t === 'a' && a.n !== b.n) out[p('n')] = b.n;
    var ac = a.c || {}, bc = b.c || {};
    childKeys(ac).forEach(function(k){
      if(bc[k] === undefined || bc[k] === null) out[p('c/' + k)] = null;
    });
    childKeys(bc).forEach(function(k){ diff(ac[k], bc[k], p('c/' + k), out); });
    return out;
  }

  function nodesEqual(a, b){
    if(a === b) return true;
    if(!isBranch(a) || !isBranch(b)) return false;
    if(a.t !== b.t || (a.t === 'a' && a.n !== b.n)) return false;
    var ak = childKeys(a.c), bk = childKeys(b.c);
    if(ak.length !== bk.length) return false;
    for(var i=0;i<ak.length;i++){
      if(!nodesEqual(a.c[ak[i]], (b.c || {})[ak[i]])) return false;
    }
    return true;
  }

  // Apply a diff (relative paths) to a node, returning a new node.
  function patch(node, updates){
    var root = { v: clone(node) };
    Object.keys(updates).sort(function(x, y){ return x.length - y.length; }).forEach(function(path){
      var segs = path ? path.split('/') : [];
      var parent = root, key = 'v';
      for(var i=0;i<segs.length;i++){
        if(!isBranch(parent[key])) parent[key] = {};
        parent = parent[key];
        key = segs[i];
      }
      var val = updates[path];
      if(val === null || val === undefined){
        if(Array.isArray(parent)) parent[key] = null; else delete parent[key];
      } else {
        parent[key] = clone(val);
      }
    });
    return root.v === undefined ? null : root.v;
  }

  function clone(n){
    if(!isBranch(n)) return n;
    var out = Array.isArray(n) ? [] : {};
    Object.keys(n).forEach(function(k){ out[k] = clone(n[k]); });
    return out;
  }

  // Key-order-insensitive deep equality of two JSON values.
  function deepEqual(a, b){
    if(a === b) return true;
    if(a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if(Array.isArray(a) !== Array.isArray(b)) return false;
    if(Array.isArray(a)){
      if(a.length !== b.length) return false;
      for(var i=0;i<a.length;i++) if(!deepEqual(a[i], b[i])) return false;
      return true;
    }
    var ak = Object.keys(a).filter(function(k){ return a[k] !== undefined; });
    var bk = Object.keys(b).filter(function(k){ return b[k] !== undefined; });
    if(ak.length !== bk.length) return false;
    for(var j=0;j<ak.length;j++){
      if(!Object.prototype.hasOwnProperty.call(b, ak[j])) return false;
      if(!deepEqual(a[ak[j]], b[ak[j]])) return false;
    }
    return true;
  }

  // Do two raw saved strings hold the same data?
  function rawEqual(r1, r2){
    if(r1 === r2) return true;
    if(r1 === null || r2 === null) return false;
    var a, b;
    try{ a = JSON.parse(r1); b = JSON.parse(r2); }catch(e){ return false; }
    return deepEqual(a, b);
  }

  // True for values that mean "nothing saved here".
  function isEmptyRaw(raw){
    if(raw === null || raw === undefined) return true;
    var t = String(raw).trim();
    if(t === '' || t === '[]' || t === '{}' || t === 'null' || t === '""') return true;
    try{
      var v = JSON.parse(t);
      if(v && typeof v === 'object' && !Array.isArray(v)){
        // e.g. {"edits":{},"added":[],"deletedIds":{}} or {"items":[],"log":[]}
        return Object.keys(v).every(function(k){
          var x = v[k];
          return x === null || x === '' || (Array.isArray(x) && x.length === 0) ||
                 (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0);
        });
      }
    }catch(e){}
    return false;
  }

  // Rough "how much is in here" for the migration screen.
  function describeRaw(raw){
    if(raw === null || raw === undefined) return { bytes:0, items:0, text:'—' };
    var bytes = String(raw).length, items = 0;
    try{
      var v = JSON.parse(raw);
      if(Array.isArray(v)) items = v.length;
      else if(v && typeof v === 'object'){
        Object.keys(v).forEach(function(k){
          var x = v[k];
          if(Array.isArray(x)) items += x.length;
          else if(x && typeof x === 'object') items += Object.keys(x).length;
          else items += 1;
        });
      }
    }catch(e){ items = 1; }
    var size = bytes > 1048576 ? (bytes/1048576).toFixed(1) + ' MB' : bytes > 1024 ? Math.round(bytes/1024) + ' KB' : bytes + ' B';
    return { bytes:bytes, items:items, text: items + ' items · ' + size };
  }

  ST.codec = {
    encSeg:encSeg, decSeg:decSeg, toNode:toNode, fromNode:fromNode,
    rawToNode:rawToNode, nodeToRaw:nodeToRaw, diff:diff, patch:patch,
    nodesEqual:nodesEqual, deepEqual:deepEqual, rawEqual:rawEqual,
    isEmptyRaw:isEmptyRaw, describeRaw:describeRaw, SPLIT:SPLIT
  };
})();
