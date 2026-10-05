/* =====================================================================
   SteelTrack Cloud — attachments (PDF, Excel, AutoCAD, IFC, photos...)
   ---------------------------------------------------------------------
   Each module still keeps its attachments in this browser's own file
   store (so they open instantly here), and also uploads them to Cloud
   Storage at files/<section>/<store>/<key>. On another device, when the
   file isn't there yet, it's downloaded from the cloud on first open.

   Also provides window.storage, the hook the app's modules already call
   for "cloud storage" (left over from where the app was first built).
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};
  var backend = null, access = null;
  var QUEUE_KEY = 'st-upload-queue-v1';

  function filePath(ns, key){
    var section = ST.FILE_NS_SECTION[ns];
    if(!section) return null;
    return 'files/' + section + '/' + encodeURIComponent(ns) + '/' + encodeURIComponent(String(key));
  }
  function sizeOf(data){
    if(typeof data !== 'string') return 0;
    var b64 = data.replace(/^data:[^,]*,/, '');
    return Math.floor(b64.length * 3 / 4);
  }
  function fmtBytes(n){
    return n > 1073741824 ? (n/1073741824).toFixed(1) + ' GB' : n > 1048576 ? (n/1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n/1024)) + ' KB';
  }

  // ---- uploads that failed (offline, closed tab...) are retried later ----
  function readQueue(){ try{ return JSON.parse(ST.rawLocal.get(QUEUE_KEY) || '[]'); }catch(e){ return []; } }
  function writeQueue(q){ try{ ST.rawLocal.set(QUEUE_KEY, JSON.stringify(q)); }catch(e){} }
  function enqueue(ns, key){
    var q = readQueue().filter(function(x){ return !(x.ns === ns && x.key === key); });
    q.push({ ns:ns, key:key });
    writeQueue(q);
  }
  function dequeue(ns, key){
    writeQueue(readQueue().filter(function(x){ return !(x.ns === ns && x.key === key); }));
  }

  // Read one entry straight from a module's browser file store, without
  // ever creating a store that doesn't exist (that would break the module).
  function idbRead(dbName, storeName, key){
    return idbExists(dbName).then(function(exists){
      if(!exists) return null;
      return new Promise(function(resolve){
        var req = indexedDB.open(dbName);
        req.onerror = function(){ resolve(null); };
        req.onsuccess = function(){
          var db = req.result;
          if(!db.objectStoreNames.contains(storeName)){ db.close(); return resolve(null); }
          var tx = db.transaction(storeName, 'readonly');
          var g = tx.objectStore(storeName).get(key);
          g.onsuccess = function(){ resolve(g.result || null); db.close(); };
          g.onerror = function(){ resolve(null); db.close(); };
        };
      });
    });
  }
  function idbAll(dbName, storeName){
    return idbExists(dbName).then(function(exists){
      if(!exists) return {};
      return new Promise(function(resolve){
        var req = indexedDB.open(dbName);
        req.onerror = function(){ resolve({}); };
        req.onsuccess = function(){
          var db = req.result, out = {};
          if(!db.objectStoreNames.contains(storeName)){ db.close(); return resolve(out); }
          var cur = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
          cur.onsuccess = function(e){
            var c = e.target.result;
            if(c){ out[c.key] = c.value; c.continue(); } else { db.close(); resolve(out); }
          };
          cur.onerror = function(){ db.close(); resolve(out); };
        };
      });
    });
  }
  function idbExists(dbName){
    if(!window.indexedDB) return Promise.resolve(false);
    if(!indexedDB.databases) return Promise.resolve(false); // can't check safely on this browser
    return indexedDB.databases().then(function(list){
      return list.some(function(d){ return d.name === dbName; });
    }).catch(function(){ return false; });
  }
  ST.idb = { read: idbRead, all: idbAll, exists: idbExists };

  // ---- progress chip ----
  var active = {};
  function progress(id, label, frac){
    if(frac === null){ delete active[id]; }
    else active[id] = { label:label, frac:frac };
    var ids = Object.keys(active);
    if(!ST.ui || !ST.ui.setTransfer) return;
    if(!ids.length) return ST.ui.setTransfer(null);
    var a = active[ids[0]];
    ST.ui.setTransfer(a.label + (a.frac >= 0 ? ' ' + Math.round(a.frac * 100) + '%' : '…') + (ids.length > 1 ? ' (+' + (ids.length - 1) + ' more)' : ''));
  }

  ST.files = {
    init: function(be, acc){
      backend = be; access = acc;
      // Retry anything that didn't make it up last time.
      setTimeout(ST.files.retryQueue, 4000);
      window.addEventListener('online', function(){ setTimeout(ST.files.retryQueue, 2000); });
    },
    path: filePath,
    canUse: function(ns){ return !!backend && !!filePath(ns, 'x'); },

    put: function(ns, key, data){
      var path = filePath(ns, key);
      if(!backend || !path || typeof data !== 'string') return Promise.resolve(false);
      var section = ST.FILE_NS_SECTION[ns];
      if(!access.canEdit(section)){
        if(ST.ui) ST.ui.toast('View only — this file was not shared with the team (' + ST.sectionLabel(section) + ').');
        return Promise.resolve(false);
      }
      var bytes = sizeOf(data);
      if(bytes > ST.MAX_FILE_BYTES){
        if(ST.ui) ST.ui.toast('This file is ' + fmtBytes(bytes) + ' — the limit is 2 GB per file.');
        return Promise.resolve(false);
      }
      var id = 'up:' + ns + ':' + key;
      enqueue(ns, key);
      progress(id, 'Uploading ' + fmtBytes(bytes), 0);
      var meta = { fmt: /^data:/.test(data) ? 'data_url' : 'base64', by: access.displayName(), section: section };
      if(meta.fmt === 'base64' && ns === 'erection') meta.contentType = 'application/pdf';
      return backend.putFile(path, data, meta, function(f){ progress(id, 'Uploading ' + fmtBytes(bytes), f); }).then(function(){
        progress(id, null, null);
        dequeue(ns, key);
        if(ST.ui) ST.ui.toast('File shared with the team ✔');
        return true;
      }).catch(function(err){
        progress(id, null, null);
        console.error('[SteelTrack cloud] upload failed', path, err);
        if(ST.ui) ST.ui.toast('Upload failed — the file is kept on this device and will be uploaded again automatically. (' + (err && (err.code || err.message) || err) + ')');
        return false;
      });
    },

    get: function(ns, key){
      var path = filePath(ns, key);
      if(!backend || !path) return Promise.resolve(null);
      var section = ST.FILE_NS_SECTION[ns];
      if(!access.canRead(section)) return Promise.resolve(null);
      var id = 'down:' + ns + ':' + key;
      progress(id, 'Downloading file', -1);
      return backend.getFile(path).then(function(v){
        progress(id, null, null);
        return v;
      }).catch(function(err){
        progress(id, null, null);
        console.error('[SteelTrack cloud] download failed', path, err);
        if(ST.ui) ST.ui.toast('Could not download the file from the cloud: ' + (err && (err.code || err.message) || err));
        return null;
      });
    },

    del: function(ns, key){
      var path = filePath(ns, key);
      if(!backend || !path) return Promise.resolve(false);
      if(!access.canEdit(ST.FILE_NS_SECTION[ns])) return Promise.resolve(false);
      dequeue(ns, key);
      return backend.deleteFile(path).then(function(){ return true; }).catch(function(err){
        console.error('[SteelTrack cloud] delete failed', path, err);
        return false;
      });
    },

    retryQueue: function(){
      if(!backend) return;
      readQueue().forEach(function(item){
        var dbName = ST.FILE_NS_DB[item.ns] || item.ns;
        var storeName = ST.FILE_NS_STORE[item.ns] || 'files';
        var idbKey = item.ns === 'erection' ? 'erectionDrawing:' + item.key : item.key;
        idbRead(dbName, storeName, idbKey).then(function(v){
          if(v) ST.files.put(item.ns, item.key, v); else dequeue(item.ns, item.key);
        });
      });
    }
  };

  // Called by the patched module file stores (see tools/build.py).
  window.stCloudFiles = {
    put: function(ns, key, value){ return ST.files.put(ns, key, value); },
    get: function(ns, key){ return ST.files.get(ns, key); },
    del: function(ns, key){ return ST.files.del(ns, key); }
  };

  // ---- window.storage: the "cloud storage" hook the modules already use ----
  var ERECTION = 'erectionDrawing:';
  window.storage = {
    get: function(key){
      key = String(key);
      if(key.indexOf(ERECTION) === 0){
        return ST.files.get('erection', key.slice(ERECTION.length)).then(function(v){ return v ? { key:key, value:v } : null; });
      }
      var wait = (ST.engine && ST.engine.isShared(key)) ? ST.engine.whenReady(key) : Promise.resolve();
      return wait.then(function(){
        var v = window.localStorage.getItem(key);
        return v === null ? null : { key:key, value:v };
      });
    },
    set: function(key, value){
      key = String(key); value = String(value);
      if(key.indexOf(ERECTION) === 0){
        return ST.files.put('erection', key.slice(ERECTION.length), value).then(function(){ return { key:key, value:value }; });
      }
      // The module has normally saved to localStorage already (which is
      // what gets synced); make sure, without saving twice.
      try{ if(window.localStorage.getItem(key) !== value) window.localStorage.setItem(key, value); }catch(e){}
      return Promise.resolve({ key:key, value:value });
    },
    delete: function(key){
      key = String(key);
      if(key.indexOf(ERECTION) === 0){
        return ST.files.del('erection', key.slice(ERECTION.length)).then(function(){ return { key:key, deleted:true }; });
      }
      try{ window.localStorage.removeItem(key); }catch(e){}
      return Promise.resolve({ key:key, deleted:true });
    },
    list: function(){ return Promise.resolve({ keys: [] }); }
  };
})();
