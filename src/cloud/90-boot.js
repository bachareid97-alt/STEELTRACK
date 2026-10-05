/* =====================================================================
   SteelTrack Cloud — startup
   ---------------------------------------------------------------------
   Runs in <head>, before any of the app's own code:
     1. hooks localStorage so saves can be synced
     2. covers the app with the loading / sign-in screen
     3. once signed in and approved: starts live sync, applies the
        person's section access, then reveals the app
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud;
  var ui = ST.ui;
  var CFG = window.STEELTRACK_CLOUD_CONFIG || {};
  var adminEmail = String(CFG.adminEmail || '').toLowerCase();

  document.documentElement.classList.add('st-locked');
  ST.engine.install();

  var backend = null, bootError = null;
  try{
    if(window.__ST_TEST_BACKEND__) backend = window.__ST_TEST_BACKEND__;
    else if(CFG.firebase && CFG.firebase.apiKey && CFG.firebase.apiKey.indexOf('PASTE') !== 0) backend = ST.makeFirebaseBackend(CFG.firebase);
  }catch(e){ bootError = e; console.error(e); }

  if(!backend){
    ui.message(bootError ? 'Can’t reach the cloud' : 'Cloud not set up yet',
      bootError ? 'The sign-in service didn’t load (' + (bootError.message || bootError) + '). Check the internet connection and reload.'
                : 'This copy of SteelTrack has no Firebase settings yet. Follow the setup guide (SETUP.md) to connect it.',
      [ ui.h('button', { class:'st-btn st-btn-primary', text:'Reload', onclick:function(){ location.reload(); } }) ]);
    return;
  }

  var user = null, profile = null, unsubProfile = null, started = false, creating = false;
  var lastLevels = null;

  function isBootAdmin(){ return !!(user && adminEmail && user.email === adminEmail && user.emailVerified); }
  var access = {
    uid: function(){ return user ? user.uid : null; },
    profile: function(){ return profile || (user ? { email:user.email } : null); },
    displayName: function(){ return (profile && profile.name) || (user && user.email) || ''; },
    isAdmin: function(){ return isBootAdmin() || !!(profile && profile.admin && profile.approved && !profile.disabled); },
    level: function(s){
      if(access.isAdmin()) return 'edit';
      if(!profile || !profile.approved || profile.disabled) return 'none';
      if(s === 'common') return 'edit';
      var l = (profile.perms || {})[s];
      return l === 'view' || l === 'edit' ? l : 'none';
    },
    canRead: function(s){ return access.level(s) !== 'none'; },
    canEdit: function(s){ return access.level(s) === 'edit'; }
  };
  ST.access = access;
  function levelsKey(){
    return JSON.stringify(ST.SECTION_IDS.map(function(s){ return access.level(s); })) + (access.isAdmin() ? 'A' : '');
  }

  function clearCachedData(){
    Object.keys(ST.KEY_SECTION).forEach(function(k){ try{ ST.rawLocal.remove(k); }catch(e){} });
  }

  ui.setActions({
    signIn: function(e, p){ return backend.signIn(e, p); },
    signUp: function(name, e, p){
      try{ sessionStorage.setItem('st-pending-name', name); }catch(x){}
      return backend.signUp(e, p);
    },
    reset: function(e){ return backend.resetPassword(e); },
    signOut: function(){
      if(ST.engine.hasUnsaved() && !confirm('Some changes are still uploading. Sign out anyway? They may be lost.')) return;
      clearCachedData();   // don't leave the team's data on a shared computer
      backend.signOut().then(function(){ location.reload(); });
    },
    recheck: function(){
      return backend.reloadUser().then(function(u){ if(u){ user = u; handleProfile(profile); } });
    },
    resendVerification: function(){ return backend.sendVerification(); }
  });

  ui.loading();

  backend.onAuth(function(u){
    if(unsubProfile){ unsubProfile(); unsubProfile = null; }
    if(!u){
      user = null; profile = null;
      if(started){ location.reload(); return; }
      ui.signIn();
      return;
    }
    user = u;
    ui.loading('Signing in…');
    unsubProfile = backend.on('users/' + u.uid, handleProfile, function(err){
      ui.message('Could not load your account', String(err && err.message || err),
        [ ui.h('button', { class:'st-btn', style:'width:100%', text:'Sign out', onclick:function(){ backend.signOut(); } }) ]);
    });
  });

  function handleProfile(p){
    profile = p || null;
    var claimsAdmin = adminEmail && user.email === adminEmail;
    if(claimsAdmin && !user.emailVerified) return ui.verify(user.email);
    if(!p || (isBootAdmin() && (!p.admin || !p.approved))) return createProfile();
    if(p.disabled){ if(started) return location.reload(); return ui.disabled(); }
    if(!p.approved && !access.isAdmin()){ if(started) return location.reload(); return ui.pending(p); }
    if(!started) return startApp();
    // Access changed while the app is open: simplest safe thing is to reload.
    if(levelsKey() !== lastLevels){
      ui.toast('Your access was updated by an administrator — reloading…');
      setTimeout(function(){ ui.refresh.reloadNow(); }, 1500);
    }
  }

  function createProfile(){
    if(creating) return;
    creating = true;
    var name = '';
    try{ name = sessionStorage.getItem('st-pending-name') || ''; }catch(e){}
    var asAdmin = isBootAdmin();
    var prof = {
      email: user.email,
      name: name || (profile && profile.name) || user.email.split('@')[0],
      approved: asAdmin, admin: asAdmin, disabled: false,
      created: (profile && profile.created) || Date.now()
    };
    Promise.all([ backend.set('users/' + user.uid, prof), backend.setProfileMirror(user.uid, prof) ])
      .then(function(){ creating = false; try{ sessionStorage.removeItem('st-pending-name'); }catch(e){} })
      .catch(function(err){
        creating = false;
        console.error(err);
        ui.message('Could not create your account record', String(err && err.message || err) + ' — the database security rules may not be published yet (see SETUP.md).',
          [ ui.h('button', { class:'st-btn', style:'width:100%', text:'Sign out', onclick:function(){ backend.signOut(); } }) ]);
      });
  }

  function startApp(){
    started = true;
    lastLevels = levelsKey();
    ui.loading('Loading your team’s data…');

    // On a shared computer, drop any cached data this person may not see.
    Object.keys(ST.KEY_SECTION).forEach(function(k){
      var s = ST.KEY_SECTION[k];
      if(s !== 'common' && !access.canRead(s)) ST.rawLocal.remove(k);
    });

    ST.engine.on('status', function(s){ if(s.error) ui.toast(s.error); else ui.setStatus(s); });
    ST.engine.on('blocked', function(ev){
      ui.toast('View only — you can’t change ' + ST.sectionLabel(ev.section) + '. Your change was not saved.');
      ui.refresh.request('Undoing a change you don’t have permission for', false);
    });
    ST.engine.on('remoteChange', function(ev){ ui.refresh.onRemoteChange(ev); });
    ST.engine.on('ready', function(ev){
      // The app's modules have already drawn this device's saved copy. If
      // the cloud had anything newer, reload once (behind the loading
      // screen) so every page starts from the team's latest data.
      var last = 0;
      try{ last = Number(sessionStorage.getItem('st-initial-reload') || 0); }catch(e){}
      if(ev.changed.length && Date.now() - last > 30000){
        try{ sessionStorage.setItem('st-initial-reload', String(Date.now())); }catch(e){}
        ui.refresh.reloadNow();
        return;
      }
      ui.applyAccess(access);
      ui.unlock();
      ui.refresh.restore();
      if(ev.offline) ui.toast('Working offline with the data saved on this device. Changes upload when the connection is back.');
    });

    ui.buildChip(access);
    ui.guardTabs(access);
    ui.applyAccess(access);
    ST.engine.start(backend, access);
    ST.files.init(backend, access);
    ST.admin.init(backend, access);
  }

  window.addEventListener('beforeunload', function(e){
    if(started && ST.engine.hasUnsaved()){
      ST.engine.flushAll();
      e.preventDefault();
      e.returnValue = 'Changes are still uploading.';
      return e.returnValue;
    }
  });
})();
