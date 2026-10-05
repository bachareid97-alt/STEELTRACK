/* =====================================================================
   SteelTrack Cloud — live sync engine
   ---------------------------------------------------------------------
   The app's modules all save through localStorage. This engine sits
   underneath that:
     - every saved key that belongs to a section (see 00-config.js) is
       kept in step with the Realtime Database at
       data/<section>/<key>/v  (+ data/<section>/<key>/m = who/when)
     - local edits are pushed as small diffs (only what changed)
     - teammates' edits arrive within a second; if you had an unsent
       edit to the same key, the two are merged, not overwritten
     - nothing is pushed until this device has first loaded the cloud
       copy, so an empty or stale device can never wipe the team's data
     - the first change each day to a key also saves the previous
       version under backups/<day>/... (kept 14 days)
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};
  var C = ST.codec;

  // ---- raw localStorage access that bypasses our own hooks ----
  var LS = window.localStorage;
  var nativeStorage = (typeof Storage !== 'undefined') && (LS instanceof Storage);
  var rawGet, rawSet, rawRemove;
  if(nativeStorage){
    var pGet = Storage.prototype.getItem, pSet = Storage.prototype.setItem, pRemove = Storage.prototype.removeItem;
    rawGet = function(k){ return pGet.call(LS, k); };
    rawSet = function(k, v){ return pSet.call(LS, k, v); };
    rawRemove = function(k){ return pRemove.call(LS, k); };
  } else {
    // Desktop (Electron) build: localStorage is a plain object backed by a file.
    var oGet = LS.getItem.bind(LS), oSet = LS.setItem.bind(LS), oRemove = LS.removeItem.bind(LS);
    rawGet = oGet; rawSet = oSet; rawRemove = oRemove;
  }
  ST.rawLocal = { get: rawGet, set: rawSet, remove: rawRemove };

  var GUARD_MS = 8000;           // right after loading, refuse to push "now empty" over real cloud data
  var PUSH_DELAY = 350;          // batch rapid edits
  var INITIAL_TIMEOUT = 20000;   // give up waiting for the cloud and work offline

  var backend = null, access = null;
  var K = {};                    // per-key state
  var started = false, allReady = false, applying = false;
  var readyWaiters = [];
  var inflight = 0;
  var connected = false;
  var initialChanged = [], initialStart = 0;
  var listeners = { status: [], remoteChange: [], blocked: [], ready: [] };

  function emit(name, arg){ (listeners[name] || []).forEach(function(fn){ try{ fn(arg); }catch(e){ console.error(e); } }); }

  function keyPath(key){ return 'data/' + K[key].section + '/' + C.encSeg(key); }

  function writeLocal(key, raw){
    applying = true;
    try{
      if(raw === null || raw === undefined) rawRemove(key); else rawSet(key, raw);
    }catch(e){
      console.error('[SteelTrack cloud] could not save locally', key, e);
    }finally{ applying = false; }
  }

  // ---- hooks on the app's own saves ----
  function hookStorage(){
    if(nativeStorage){
      var protoSet = Storage.prototype.setItem, protoRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function(k, v){
        var r = protoSet.call(this, k, v);
        if(this === LS) onLocal(String(k));
        return r;
      };
      Storage.prototype.removeItem = function(k){
        var r = protoRemove.call(this, k);
        if(this === LS) onLocal(String(k));
        return r;
      };
    } else {
      LS.setItem = function(k, v){ var r = rawSet(k, v); onLocal(String(k)); return r; };
      LS.removeItem = function(k){ var r = rawRemove(k); onLocal(String(k)); return r; };
    }
  }

  function onLocal(key){
    if(applying) return;
    var st = K[key];
    if(!st) return;                          // not a shared key
    if(!started || !st.ready){ st.preReady = true; return; }
    if(!st.readable || !access.canEdit(st.section)){ blocked(key); return; }
    st.dirty = true;
    clearTimeout(st.timer);
    st.timer = setTimeout(function(){ push(key); }, PUSH_DELAY);
    status();
  }

  // When did the person last tap / click / type? Modules also re-save data
  // by themselves (e.g. tidying it up when a page opens); for a view-only
  // person those saves are simply put back without any message.
  var lastInputAt = 0;
  ['pointerdown','keydown','change'].forEach(function(t){
    window.addEventListener(t, function(){ lastInputAt = Date.now(); }, true);
  });

  var lastBlockedAt = 0;
  function blocked(key){
    var st = K[key];
    // Put the cloud copy back so the change doesn't silently live on here.
    setTimeout(function(){ writeLocal(key, st.base === null || st.base === undefined ? rawGet(key) : C.nodeToRaw(st.base)); }, 0);
    var now = Date.now();
    var byPerson = now - lastInputAt < 4000;
    if(byPerson && now - lastBlockedAt > 3000){
      lastBlockedAt = now;
      emit('blocked', { key:key, section: st.section });
    }
  }

  // ---- push local edits ----
  function push(key){
    var st = K[key];
    clearTimeout(st.timer);
    if(!st.dirty) return;
    if(!access.canEdit(st.section)){ st.dirty = false; blocked(key); return; }
    var raw = rawGet(key);
    var baseRaw = st.base ? C.nodeToRaw(st.base) : null;

    if(Date.now() - st.readyAt < GUARD_MS && C.isEmptyRaw(raw) && !C.isEmptyRaw(baseRaw)){
      // A module re-initialising with empty data right after load — never
      // let that overwrite the team's real data.
      console.warn('[SteelTrack cloud] ignored an empty save of', key, 'right after loading');
      st.dirty = false;
      writeLocal(key, baseRaw);
      return;
    }

    // The module saved its whole in-memory copy, which was loaded at `seen`.
    // Take only what this person changed since then and apply that onto the
    // cloud's current version, so teammates' newer changes are never undone.
    var localNode = C.rawToNode(raw, st.base);
    var ancestor = st.seen === undefined ? st.base : st.seen;
    var ours = C.diff(ancestor, localNode);
    var newNode = C.patch(st.base, ours);
    var d = C.diff(st.base, newNode);
    var rels = Object.keys(d);
    st.dirty = false;
    st.seen = localNode;
    var mergedRaw = C.nodeToRaw(newNode);
    if(!C.rawEqual(mergedRaw, raw)) writeLocal(key, mergedRaw);   // keep this device's copy = team's latest
    if(!rels.length){ status(); return; }

    var path = keyPath(key);
    var updates = {};
    rels.forEach(function(rel){ updates[path + '/v' + (rel ? '/' + rel : '')] = d[rel]; });
    updates[path + '/m'] = { t: backend.serverTime, by: access.uid(), name: access.displayName() };

    maybeBackup(key, st.base);
    var before = st.base;
    st.base = C.patch(st.base, d);
    inflight++;
    status();
    backend.update(updates).then(function(){
      inflight--; status();
    }).catch(function(err){
      inflight--;
      console.error('[SteelTrack cloud] save failed', key, err);
      st.base = before;
      var denied = err && /permission/i.test(String(err.code || err.message || ''));
      emit('status', { error: denied ? 'You don’t have permission to change ' + ST.sectionLabel(st.section) + ' — your change was not saved.'
                                     : 'A change could not be saved to the cloud: ' + (err && err.message || err) });
      if(denied) blocked(key);
      status();
    });
  }

  function today(){
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function maybeBackup(key, node){
    if(node === null || node === undefined) return;
    var st = K[key], day = today(), mark = 'st-bk:' + key;
    if(rawGet(mark) === day) return;
    try{ rawSet(mark, day); }catch(e){}
    var u = {};
    u['backups/' + day + '/' + st.section + '/' + C.encSeg(key)] = node;
    u['backupDays/' + day] = true;
    // Fails harmlessly when someone already backed this key up today.
    backend.update(u).catch(function(){});
  }

  // ---- receive cloud changes ----
  function onRemote(key, val){
    var st = K[key];
    var node = val ? (val.v === undefined ? null : val.v) : null;
    var meta = val ? val.m : null;
    var first = !st.ready;
    var changed = false;

    if(st.dirty){
      // Unsent local edit + a teammate's edit: the pending push merges the
      // two (yours wins only where you both changed the very same spot).
      st.base = node;
      clearTimeout(st.timer);
      st.timer = setTimeout(function(){ push(key); }, PUSH_DELAY);
    } else {
      st.base = node;
      if(node !== null){
        var remoteRaw = C.nodeToRaw(node);
        if(!C.rawEqual(remoteRaw, rawGet(key))){ writeLocal(key, remoteRaw); changed = true; }
      }
      // Nothing in the cloud yet: keep whatever this device has.
    }

    if(first){
      st.ready = true;
      st.readyAt = Date.now();
      // What this page's modules are working from (if anything changed, the
      // page reloads before anyone can edit, and this is set again).
      st.seen = node !== null ? node : C.rawToNode(rawGet(key), null);
      if(changed) initialChanged.push(key);
      checkAllReady();
    } else if(changed){
      emit('remoteChange', { key:key, section:st.section, meta:meta, mine: meta && meta.by === access.uid() });
    }
    flushWaiters();
  }

  function onRemoteError(key, err){
    var st = K[key];
    console.warn('[SteelTrack cloud] cannot read', key, err && err.message);
    st.readable = false;
    if(!st.ready){ st.ready = true; st.readyAt = Date.now(); checkAllReady(); }
    flushWaiters();
  }

  function checkAllReady(){
    if(allReady) return;
    for(var k in K) if(!K[k].ready) return;
    allReady = true;
    status();
    emit('ready', { changed: initialChanged.slice(), ms: Date.now() - initialStart, offline:false });
  }

  function flushWaiters(){
    readyWaiters = readyWaiters.filter(function(w){
      if(allReady || (K[w.key] && K[w.key].ready)){ w.resolve(); return false; }
      return true;
    });
  }

  // ---- status ----
  function status(){
    var dirty = 0;
    for(var k in K) if(K[k].dirty) dirty++;
    emit('status', { connected:connected, ready:allReady, saving: inflight + dirty });
  }

  // ---- public ----
  ST.engine = {
    // Install the localStorage hooks as early as possible.
    install: function(){
      Object.keys(ST.KEY_SECTION).forEach(function(key){
        K[key] = { section: ST.KEY_SECTION[key], base: null, ready: false, readable: true,
                   dirty: false, preReady: false, timer: null, readyAt: 0 };
      });
      hookStorage();
    },
    start: function(be, acc){
      if(started) return;
      backend = be; access = acc; started = true;
      initialStart = Date.now();
      backend.onConnected(function(c){ connected = c; status(); });
      Object.keys(K).forEach(function(key){
        var st = K[key];
        if(st.section !== 'common' && !access.canRead(st.section)){
          st.readable = false; st.ready = true; st.readyAt = Date.now();
          return;
        }
        st.unsub = backend.on(keyPath(key), function(val){ onRemote(key, val); }, function(err){ onRemoteError(key, err); });
      });
      checkAllReady();
      setTimeout(function(){
        if(allReady) return;
        allReady = true;   // let the app run on what this device has
        flushWaiters();
        status();
        emit('ready', { changed: initialChanged.slice(), ms: Date.now() - initialStart, offline:true });
      }, INITIAL_TIMEOUT);
    },
    stop: function(){
      Object.keys(K).forEach(function(k){ if(K[k].unsub) K[k].unsub(); K[k].unsub = null; });
      started = false;
    },
    whenReady: function(key){
      if(allReady || !K[key] || K[key].ready) return Promise.resolve();
      return new Promise(function(resolve){ readyWaiters.push({ key:key, resolve:resolve }); });
    },
    isShared: function(key){ return !!K[key]; },
    isReady: function(){ return allReady; },
    hasUnsaved: function(){
      if(inflight) return true;
      for(var k in K) if(K[k].dirty) return true;
      return false;
    },
    flushAll: function(){ Object.keys(K).forEach(function(k){ if(K[k].dirty) push(k); }); },
    cloudNode: function(key){ return K[key] ? K[key].base : null; },
    // Used by the migration/restore tools: replace a key's cloud value.
    writeWhole: function(key, raw, extraUpdates){
      var st = K[key];
      var node = C.rawToNode(raw, null);
      var updates = extraUpdates || {};
      var path = keyPath(key);
      updates[path + '/v'] = node;
      updates[path + '/m'] = { t: backend.serverTime, by: access.uid(), name: access.displayName() };
      return backend.update(updates).then(function(){
        st.base = node;
        st.seen = node;
        writeLocal(key, raw);
      });
    },
    keyPath: function(key){ return keyPath(key); },
    // For troubleshooting (also handy in the browser console).
    debugState: function(){
      var notReady = Object.keys(K).filter(function(k){ return !K[k].ready; });
      return { started:started, allReady:allReady, connected:connected, inflight:inflight, waiting:notReady };
    },
    on: function(name, fn){ (listeners[name] = listeners[name] || []).push(fn); }
  };
})();
