/* =====================================================================
   SteelTrack Cloud — Firebase adapter
   ---------------------------------------------------------------------
   The only file that talks to Firebase directly. Everything else uses
   this small interface, so it can be swapped for a test stand-in.
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};

  ST.makeFirebaseBackend = function(cfg){
    if(!window.firebase || !firebase.initializeApp) throw new Error('Firebase SDK did not load');
    var app = firebase.initializeApp(cfg);
    var auth = firebase.auth();
    var db = firebase.database();
    var fs = firebase.firestore();
    var storage = firebase.storage();
    var TS = firebase.database.ServerValue.TIMESTAMP;

    function u2o(u){
      return u ? { uid:u.uid, email:(u.email||'').toLowerCase(), emailVerified:!!u.emailVerified } : null;
    }

    function blobToDataUrl(blob){
      return new Promise(function(resolve, reject){
        var r = new FileReader();
        r.onload = function(){ resolve(r.result); };
        r.onerror = function(){ reject(r.error || new Error('Could not read downloaded file')); };
        r.readAsDataURL(blob);
      });
    }

    return {
      kind: 'firebase',
      serverTime: TS,

      // ---- auth ----
      onAuth: function(cb){ return auth.onAuthStateChanged(function(u){ cb(u2o(u)); }); },
      currentUser: function(){ return u2o(auth.currentUser); },
      reloadUser: function(){ return auth.currentUser ? auth.currentUser.reload().then(function(){ return u2o(auth.currentUser); }) : Promise.resolve(null); },
      signIn: function(email, pw){ return auth.signInWithEmailAndPassword(email, pw); },
      signUp: function(email, pw){
        return auth.createUserWithEmailAndPassword(email, pw).then(function(c){
          return c.user.sendEmailVerification().catch(function(){}).then(function(){ return u2o(c.user); });
        });
      },
      sendVerification: function(){ return auth.currentUser ? auth.currentUser.sendEmailVerification() : Promise.resolve(); },
      resetPassword: function(email){ return auth.sendPasswordResetEmail(email); },
      signOut: function(){ return auth.signOut(); },

      // ---- realtime database ----
      get: function(path){ return db.ref(path).get().then(function(s){ return s.val(); }); },
      set: function(path, val){ return db.ref(path).set(val); },
      update: function(map){ return db.ref().update(map); },
      remove: function(path){ return db.ref(path).remove(); },
      on: function(path, cb, errCb){
        var ref = db.ref(path);
        var h = ref.on('value', function(s){ cb(s.val()); }, function(e){ if(errCb) errCb(e); });
        return function(){ ref.off('value', h); };
      },
      onConnected: function(cb){
        var ref = db.ref('.info/connected');
        var h = ref.on('value', function(s){ cb(s.val() === true); });
        return function(){ ref.off('value', h); };
      },

      // ---- user profile mirror (read by the file-storage security rules) ----
      setProfileMirror: function(uid, profile){
        return fs.collection('users').doc(uid).set(profile);
      },

      // ---- files ----
      putFile: function(path, dataUrl, meta, onProgress){
        return new Promise(function(resolve, reject){
          var fmt = /^data:/.test(dataUrl) ? 'data_url' : 'base64';
          var opts = { customMetadata: meta || {} };
          if(fmt === 'base64' && meta && meta.contentType) opts.contentType = meta.contentType;
          var task = storage.ref(path).putString(dataUrl, fmt, opts);
          task.on('state_changed', function(s){
            if(onProgress && s.totalBytes) onProgress(s.bytesTransferred / s.totalBytes);
          }, reject, function(){ resolve(true); });
        });
      },
      getFile: function(path){
        var ref = storage.ref(path);
        return ref.getMetadata().then(function(md){
          return ref.getDownloadURL().then(function(url){
            return fetch(url).then(function(r){
              if(!r.ok) throw new Error('Download failed (' + r.status + ')');
              return r.blob();
            });
          }).then(blobToDataUrl).then(function(dataUrl){
            var fmt = md.customMetadata && md.customMetadata.fmt;
            if(fmt === 'base64') return dataUrl.replace(/^data:[^,]*,/, '');
            return dataUrl;
          });
        }).catch(function(e){
          if(e && e.code === 'storage/object-not-found') return null;
          throw e;
        });
      },
      deleteFile: function(path){
        return storage.ref(path).delete().catch(function(e){
          if(e && e.code === 'storage/object-not-found') return true;
          throw e;
        });
      }
    };
  };
})();
