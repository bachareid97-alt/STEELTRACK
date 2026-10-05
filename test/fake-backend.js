// Browser side of the test stand-in (see fake-server.js). Implements the
// same small interface as src/cloud/20-backend-firebase.js.
(function(){
  var url = (window.__ST_FAKE_URL__) || 'ws://127.0.0.1:8790';
  var ws, seq = 0, pending = {}, subs = {}, queue = [], open = false;
  var user = null, authCbs = [], connCbs = [];
  var SESSION = 'fake-auth-session';

  function connect(){
    ws = new WebSocket(url);
    ws.onopen = function(){
      open = true;
      connCbs.forEach(function(cb){ cb(true); });
      var saved = null; try{ saved = JSON.parse(localStorage.getItem(SESSION) || 'null'); }catch(e){}
      var flush = function(){ var q = queue; queue = []; q.forEach(function(m){ ws.send(JSON.stringify(m)); }); };
      if(saved){
        rawCall({ op:'signIn', email:saved.email, pw:saved.pw }).then(function(u){ setUser(u); flush(); }).catch(function(){ setUser(null); flush(); });
      } else { setUser(null); flush(); }
    };
    ws.onmessage = function(e){
      var m = JSON.parse(e.data);
      if(m.id && pending[m.id]){
        var p = pending[m.id]; delete pending[m.id];
        if(m.ok) p.resolve(m.result); else { var err = new Error(m.error); err.code = m.code; p.reject(err); }
      } else if(m.ev && subs[m.sub]){
        if(m.ev === 'value') subs[m.sub].cb(m.val);
        else if(subs[m.sub].err) subs[m.sub].err(new Error(m.error));
      }
    };
  }
  function rawCall(m){
    m.id = ++seq;
    return new Promise(function(resolve, reject){
      pending[m.id] = { resolve:resolve, reject:reject };
      ws.send(JSON.stringify(m));
    });
  }
  function call(m){
    m.id = ++seq;
    return new Promise(function(resolve, reject){
      pending[m.id] = { resolve:resolve, reject:reject };
      if(open && user !== undefined && !authPending) ws.send(JSON.stringify(m)); else queue.push(m);
    });
  }
  var authPending = true;
  function setUser(u){
    authPending = false;
    user = u ? { uid:u.uid, email:u.email, emailVerified:!!u.verified } : null;
    authCbs.forEach(function(cb){ cb(user); });
  }
  connect();

  window.__ST_TEST_BACKEND__ = {
    kind:'fake',
    serverTime: 0,
    onAuth: function(cb){ authCbs.push(cb); if(!authPending) cb(user); return function(){}; },
    currentUser: function(){ return user; },
    reloadUser: function(){ return Promise.resolve(user); },
    signIn: function(email, pw){
      return rawCall({ op:'signIn', email:email, pw:pw }).then(function(u){
        localStorage.setItem(SESSION, JSON.stringify({ email:email, pw:pw })); setUser(u); return u;
      });
    },
    signUp: function(email, pw){
      return rawCall({ op:'signUp', email:email, pw:pw }).then(function(u){
        localStorage.setItem(SESSION, JSON.stringify({ email:email, pw:pw })); setUser(u); return u;
      });
    },
    sendVerification: function(){ return Promise.resolve(); },
    resetPassword: function(){ return Promise.resolve(); },
    signOut: function(){ localStorage.removeItem(SESSION); return rawCall({ op:'signOut' }).then(function(){ setUser(null); }); },
    get: function(path){ return call({ op:'get', path:path }); },
    set: function(path, val){ return call({ op:'set', path:path, val: val === undefined ? null : val }); },
    update: function(map){
      var m = {}; Object.keys(map).forEach(function(k){ m[k] = map[k] === 0 && /\/m$/.test(k) ? Date.now() : map[k]; });
      Object.keys(m).forEach(function(k){ if(m[k] && typeof m[k] === 'object' && m[k].t === 0) m[k].t = Date.now(); });
      return call({ op:'update', map:m });
    },
    remove: function(path){ return call({ op:'set', path:path, val:null }); },
    on: function(path, cb, errCb){
      var id = 's' + (++seq);
      subs[id] = { cb:cb, err:errCb };
      call({ op:'sub', path:path, sub:id }).catch(function(e){ if(errCb) errCb(e); });
      return function(){ delete subs[id]; call({ op:'unsub', sub:id }).catch(function(){}); };
    },
    onConnected: function(cb){ connCbs.push(cb); if(open) cb(true); return function(){}; },
    setProfileMirror: function(){ return Promise.resolve(); },
    putFile: function(path, data, meta, onProgress){ if(onProgress) onProgress(0.5); return call({ op:'putFile', path:path, data:data, meta:meta }); },
    getFile: function(path){ return call({ op:'getFile', path:path }); },
    deleteFile: function(path){ return call({ op:'delFile', path:path }); }
  };
})();
