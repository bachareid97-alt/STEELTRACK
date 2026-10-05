/* =====================================================================
   SteelTrack Cloud — screens and in-app indicators
   ---------------------------------------------------------------------
   Sign-in / sign-up / approval screens, the live-status chip, toasts,
   hiding and locking sections by permission, and refreshing the page
   when teammates change something you're looking at.
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};

  function h(tag, attrs, kids){
    var el = document.createElement(tag);
    if(attrs) Object.keys(attrs).forEach(function(k){
      var v = attrs[k];
      if(v === null || v === undefined || v === false) return;
      if(k === 'text') el.textContent = v;
      else if(k === 'html') el.innerHTML = v;
      else if(k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if(k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function(c){ if(c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function onReady(fn){
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn();
  }
  function friendlyAuthError(err){
    var code = (err && err.code) || '';
    var map = {
      'auth/invalid-email':'That email address doesn’t look right.',
      'auth/user-not-found':'No account with that email. Use “Create account” first.',
      'auth/wrong-password':'Wrong password. Try again or reset it.',
      'auth/invalid-credential':'Email or password is wrong.',
      'auth/invalid-login-credentials':'Email or password is wrong.',
      'auth/email-already-in-use':'An account with this email already exists — sign in instead.',
      'auth/weak-password':'Use a password of at least 8 characters.',
      'auth/too-many-requests':'Too many attempts. Wait a few minutes and try again.',
      'auth/network-request-failed':'No internet connection.'
    };
    return map[code] || (err && err.message) || String(err);
  }

  // ------------------------------------------------------------------
  // Cover screen
  // ------------------------------------------------------------------
  var cover, card;
  function ensureCover(){
    if(cover) return;
    cover = h('div', { id:'stCover' });
    card = h('div', { class:'st-card' });
    cover.appendChild(card);
    document.body.appendChild(cover);
  }
  function screen(kids){
    onReady(function(){
      ensureCover();
      cover.hidden = false;
      document.documentElement.classList.add('st-locked');
      card.innerHTML = '';
      card.appendChild(h('div', { class:'st-logo', text:'ST' }));
      kids.forEach(function(k){ if(k) card.appendChild(k); });
      var first = card.querySelector('input');
      // Put the cursor in the first box, unless the person is already typing.
      if(first) setTimeout(function(){
        try{
          var a = document.activeElement;
          if(!(a && card.contains(a) && a.tagName === 'INPUT')) first.focus();
        }catch(e){}
      }, 50);
    });
  }
  function field(id, label, type, extra){
    return h('div', { class:'st-field' }, [
      h('label', { for:id, text:label }),
      h('input', Object.assign({ id:id, type:type || 'text' }, extra || {}))
    ]);
  }
  function msgBox(){ return h('div', { class:'st-msg', id:'stMsg' }); }
  function showMsg(text, ok){
    var m = document.getElementById('stMsg');
    if(!m) return;
    m.className = 'st-msg ' + (ok ? 'ok' : 'err');
    m.textContent = text;
  }
  function busyBtn(btn, busy, label){
    btn.disabled = busy;
    if(label) btn.textContent = label;
  }
  function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function enterSubmits(btn){
    card.querySelectorAll('input').forEach(function(i){
      i.addEventListener('keydown', function(e){ if(e.key === 'Enter') btn.click(); });
    });
  }

  var actions = {};   // set by boot: signIn, signUp, reset, signOut, recheck, resendVerification

  var ui = ST.ui = {
    h: h,
    onReady: onReady,
    setActions: function(a){ actions = a; },

    loading: function(text){
      screen([ h('div', { class:'st-spinner' }), h('h2', { text: text || 'Connecting…' }),
               h('p', { class:'st-sub', text:'Loading your team’s live data' }) ]);
    },

    message: function(title, body, buttons){
      screen([ h('h2', { text:title }), h('p', { class:'st-sub', text:body }) ].concat(buttons || []));
    },

    signIn: function(prefillEmail){
      var btn = h('button', { class:'st-btn st-btn-primary', text:'Sign in' });
      screen([
        h('h2', { text:'SteelTrack' }),
        h('p', { class:'st-sub', text:'Sign in with your personal account' }),
        field('stEmail', 'Email', 'email', { autocomplete:'username', value: prefillEmail || '' }),
        field('stPass', 'Password', 'password', { autocomplete:'current-password' }),
        btn, msgBox(),
        h('div', { class:'st-links' }, [
          h('button', { class:'st-link', text:'Create account', onclick:function(){ ui.signUp(val('stEmail')); } }),
          h('button', { class:'st-link', text:'Forgot password?', onclick:function(){ ui.reset(val('stEmail')); } })
        ])
      ]);
      onReady(function(){
        btn.addEventListener('click', function(){
          var e = val('stEmail'), p = document.getElementById('stPass').value;
          if(!e || !p) return showMsg('Enter your email and password.');
          busyBtn(btn, true, 'Signing in…');
          actions.signIn(e, p).catch(function(err){ busyBtn(btn, false, 'Sign in'); showMsg(friendlyAuthError(err)); });
        });
        enterSubmits(btn);
      });
    },

    signUp: function(prefillEmail){
      var btn = h('button', { class:'st-btn st-btn-primary', text:'Create account' });
      screen([
        h('h2', { text:'Create your account' }),
        h('p', { class:'st-sub', text:'Your administrator will approve it and choose which sections you can see and edit.' }),
        field('stName', 'Full name', 'text', { autocomplete:'name' }),
        field('stEmail', 'Work email', 'email', { autocomplete:'username', value: prefillEmail || '' }),
        field('stPass', 'Password (at least 8 characters)', 'password', { autocomplete:'new-password' }),
        btn, msgBox(),
        h('div', { class:'st-links' }, [
          h('button', { class:'st-link', text:'← Back to sign in', onclick:function(){ ui.signIn(val('stEmail')); } })
        ])
      ]);
      onReady(function(){
        btn.addEventListener('click', function(){
          var n = val('stName'), e = val('stEmail'), p = document.getElementById('stPass').value;
          if(!n) return showMsg('Enter your full name so the admin knows who you are.');
          if(!e) return showMsg('Enter your email.');
          if(!p || p.length < 8) return showMsg('Use a password of at least 8 characters.');
          busyBtn(btn, true, 'Creating…');
          actions.signUp(n, e, p).catch(function(err){ busyBtn(btn, false, 'Create account'); showMsg(friendlyAuthError(err)); });
        });
        enterSubmits(btn);
      });
    },

    reset: function(prefillEmail){
      var btn = h('button', { class:'st-btn st-btn-primary', text:'Send reset link' });
      screen([
        h('h2', { text:'Reset password' }),
        h('p', { class:'st-sub', text:'We’ll email you a link to choose a new password.' }),
        field('stEmail', 'Email', 'email', { value: prefillEmail || '' }),
        btn, msgBox(),
        h('div', { class:'st-links' }, [
          h('button', { class:'st-link', text:'← Back to sign in', onclick:function(){ ui.signIn(val('stEmail')); } })
        ])
      ]);
      onReady(function(){
        btn.addEventListener('click', function(){
          var e = val('stEmail');
          if(!e) return showMsg('Enter your email.');
          busyBtn(btn, true, 'Sending…');
          actions.reset(e).then(function(){
            busyBtn(btn, false, 'Send reset link');
            showMsg('Done — check your inbox (and spam folder) for the reset link.', true);
          }).catch(function(err){ busyBtn(btn, false, 'Send reset link'); showMsg(friendlyAuthError(err)); });
        });
        enterSubmits(btn);
      });
    },

    pending: function(profile){
      screen([
        h('h2', { text:'Waiting for approval' }),
        h('p', { class:'st-sub', text:'Your account (' + (profile && profile.email || '') + ') was created. An administrator needs to approve it and set your access. This page opens by itself once they do.' }),
        h('button', { class:'st-btn', style:'width:100%', text:'Sign out', onclick:function(){ actions.signOut(); } })
      ]);
    },

    disabled: function(){
      screen([
        h('h2', { text:'Account disabled' }),
        h('p', { class:'st-sub', text:'Your access to SteelTrack has been turned off. Contact your administrator if this is a mistake.' }),
        h('button', { class:'st-btn', style:'width:100%', text:'Sign out', onclick:function(){ actions.signOut(); } })
      ]);
    },

    verify: function(email){
      var resend = h('button', { class:'st-btn', style:'width:100%;margin-bottom:8px', text:'Send the email again' });
      screen([
        h('h2', { text:'Confirm your email' }),
        h('p', { class:'st-sub', text:'As the administrator account, ' + email + ' must be confirmed first. Open the link we emailed you, then press “I’ve confirmed”.' }),
        h('button', { class:'st-btn st-btn-primary', style:'margin-bottom:8px', text:'I’ve confirmed', onclick:function(){ actions.recheck(); } }),
        resend,
        h('button', { class:'st-btn', style:'width:100%', text:'Sign out', onclick:function(){ actions.signOut(); } }),
        msgBox()
      ]);
      onReady(function(){
        resend.addEventListener('click', function(){
          actions.resendVerification().then(function(){ showMsg('Sent. Check your inbox and spam folder.', true); })
            .catch(function(err){ showMsg(friendlyAuthError(err)); });
        });
      });
    },

    unlock: function(){
      onReady(function(){
        if(cover) cover.hidden = true;
        document.documentElement.classList.remove('st-locked');
      });
    },

    // ------------------------------------------------------------------
    // Toasts
    // ------------------------------------------------------------------
    toast: function(text){
      if(typeof window.ft_toast === 'function'){ try{ window.ft_toast(text); return; }catch(e){} }
      onReady(function(){
        var box = document.getElementById('stToasts');
        if(!box){ box = h('div', { id:'stToasts' }); document.body.appendChild(box); }
        var t = h('div', { class:'st-toast', text:text });
        box.appendChild(t);
        setTimeout(function(){ t.remove(); }, 5000);
      });
    },

    // ------------------------------------------------------------------
    // Status chip (bottom right) + account menu
    // ------------------------------------------------------------------
    chip: null, menu: null, transfer: null, lastStatus: null, attention: null,
    buildChip: function(access){
      onReady(function(){
        if(ui.chip) return;
        ui.chip = h('div', { id:'stChip', title:'Live sync status — click for your account' }, [
          h('span', { class:'dot' }), h('span', { class:'st-chip-text', text:'Connecting…' })
        ]);
        ui.menu = h('div', { id:'stMenu', hidden:true });
        document.body.appendChild(ui.chip);
        document.body.appendChild(ui.menu);
        ui.chip.addEventListener('click', function(){
          if(ui.attention){ var a = ui.attention; ui.attention = null; a(); return; }
          ui.menu.hidden = !ui.menu.hidden;
          if(!ui.menu.hidden) ui.renderMenu(access);
        });
        document.addEventListener('click', function(e){
          if(!ui.menu.hidden && !ui.menu.contains(e.target) && !ui.chip.contains(e.target)) ui.menu.hidden = true;
        });
        ui.renderChip();
      });
    },
    renderMenu: function(access){
      var p = access.profile() || {};
      var rows = ST.SECTIONS.map(function(s){
        var l = access.level(s.id);
        return h('div', { class:'st-menu-row' }, [ h('span', { text:s.label }),
          h('span', { class:'lvl-' + l, text: l === 'edit' ? 'Can edit' : l === 'view' ? 'View only' : 'No access' }) ]);
      });
      ui.menu.innerHTML = '';
      ui.menu.appendChild(h('div', { class:'st-menu-name', text:(p.name || 'Signed in') + (access.isAdmin() ? '  ·  Admin' : '') }));
      ui.menu.appendChild(h('div', { class:'st-menu-email', text:p.email || '' }));
      ui.menu.appendChild(h('div', { class:'st-menu-rows' }, rows));
      ui.menu.appendChild(h('button', { class:'st-btn', style:'width:100%', text:'Sign out', onclick:function(){ actions.signOut(); } }));
    },
    setStatus: function(s){ ui.lastStatus = s; ui.renderChip(); },
    setTransfer: function(text){ ui.transfer = text; ui.renderChip(); },
    needsAttention: function(text, fn){ ui.attention = fn; ui.attentionText = text; ui.renderChip(); },
    renderChip: function(){
      if(!ui.chip) return;
      var s = ui.lastStatus || {};
      var cls = 'busy', text = 'Connecting…';
      if(s.connected && s.ready){ cls = 'live'; text = 'Live · synced'; }
      if(s.connected && s.saving){ cls = 'busy'; text = 'Saving…'; }
      if(s.ready && !s.connected){ cls = 'off'; text = s.saving ? 'Offline — changes will upload when you’re back online' : 'Offline'; }
      if(ui.transfer){ cls = 'busy'; text = ui.transfer; }
      if(ui.attention){ text = ui.attentionText; }
      ui.chip.className = cls + (ui.attention ? ' attn' : '');
      ui.chip.querySelector('.st-chip-text').textContent = text;
      // Keep the app's own header indicator in step.
      if(window.__steeltrackStatus){
        window.__steeltrackStatus.sync = cls === 'live' ? 'Live cloud sync' : text;
        window.__steeltrackStatus.syncColor = cls === 'live' ? '#22c55e' : cls === 'off' ? '#ef4444' : '#eab308';
        if(typeof window.__steeltrackRenderStatus === 'function') window.__steeltrackRenderStatus();
      }
    },

    // ------------------------------------------------------------------
    // Hide / lock sections by permission
    // ------------------------------------------------------------------
    tabAllowed: function(access, tab){
      if(ST.HIDDEN_TABS[tab]) return false;
      if(ST.ADMIN_TABS[tab]) return access.isAdmin();
      var sec = ST.TAB_SECTION[tab];
      return !sec || access.level(sec) !== 'none';
    },
    applyAccess: function(access){
      onReady(function(){
        document.body.classList.add('authed');
        window.CURRENT_ROLE = 'admin';   // the app's old viewer mode is replaced by per-section access
        document.body.classList.remove('viewer-mode');

        document.querySelectorAll('.maintab-btn[data-maintab]').forEach(function(btn){
          var tab = btn.getAttribute('data-maintab');
          var allowed = ui.tabAllowed(access, tab);
          btn.classList.toggle('st-hidden', !allowed);
          var panel = document.getElementById('maintab-' + tab);
          if(!panel) return;
          panel.classList.toggle('st-hidden', !allowed);
          var sec = ST.TAB_SECTION[tab];
          var ro = allowed && sec && access.level(sec) === 'view';
          panel.classList.toggle('st-ro', !!ro);
          var banner = panel.querySelector(':scope > .st-ro-banner');
          if(ro && !banner){
            panel.insertBefore(h('div', { class:'st-ro-banner', text:'👁 View only — you can look at ' + ST.sectionLabel(sec) + ' but not change it. Ask your administrator if you need edit access.' }), panel.firstChild);
          } else if(!ro && banner){ banner.remove(); }
        });
        // Hide sidebar groups that have nothing left in them.
        document.querySelectorAll('.sidebar-group[data-group]').forEach(function(g){
          var any = Array.prototype.some.call(g.querySelectorAll('.maintab-btn'), function(b){ return !b.classList.contains('st-hidden'); });
          g.classList.toggle('st-hidden', !any);
          var label = document.querySelector('[data-group-toggle="' + g.getAttribute('data-group') + '"]');
          if(label) label.classList.toggle('st-hidden', !any);
        });
        // If the open page is no longer allowed, go to the dashboard.
        var active = document.querySelector('.maintab-btn.active');
        if(active && active.classList.contains('st-hidden')){
          var dash = document.querySelector('.maintab-btn[data-maintab="dashboard"]');
          if(dash) dash.click();
        }
        // The old "Download Full Backup" builds a file holding all data: admins only.
        var fb = document.getElementById('fullBackupBtn');
        if(fb) fb.classList.toggle('st-hidden', !access.isAdmin());
        // Header: show who is signed in, and make "log out" sign out.
        var p = access.profile() || {};
        var roleLabel = document.getElementById('roleLabel');
        if(roleLabel){
          roleLabel.style.display = 'flex';
          roleLabel.innerHTML = '';
          roleLabel.appendChild(h('span', { class:'dot', style:'background:' + (access.isAdmin() ? 'var(--green)' : 'var(--blue)') }));
          roleLabel.appendChild(h('span', { text:(p.name || p.email || 'Signed in') + (access.isAdmin() ? ' · Admin' : '') }));
        }
        var logout = document.getElementById('logoutBtn');
        if(logout && !logout.__stWired){
          logout.__stWired = true;
          logout.style.display = 'inline-flex';
          logout.addEventListener('click', function(e){ e.preventDefault(); e.stopImmediatePropagation(); actions.signOut(); }, true);
        }
      });
    },

    // Block opening pages you don't have access to (dashboard shortcuts etc.)
    guardTabs: function(access){
      onReady(function(){
        document.addEventListener('click', function(e){
          var btn = e.target.closest && e.target.closest('.maintab-btn[data-maintab]');
          if(!btn) return;
          var tab = btn.getAttribute('data-maintab');
          if(!ui.tabAllowed(access, tab)){
            e.preventDefault(); e.stopImmediatePropagation();
            ui.toast('You don’t have access to this page. Ask your administrator.');
            return;
          }
          if(ui.refresh.staleFor(tab)){
            e.preventDefault(); e.stopImmediatePropagation();
            ui.refresh.reloadInto(tab);
          }
        }, true);
      });
    }
  };

  // ------------------------------------------------------------------
  // Showing teammates' changes
  // ------------------------------------------------------------------
  // Modules keep their own copy of the data in memory, so the reliable way
  // to show a teammate's change is to reload the page. To keep that from
  // being disruptive: only reload when the change concerns the page you're
  // on, never while you're typing or have a form open, never more often
  // than every few seconds, and come back to the same page and scroll spot.
  var RESTORE_KEY = 'st-restore-v1';
  var stale = {};
  var pending = false, lastReload = 0;

  function activeTab(){
    var b = document.querySelector('.maintab-btn.active');
    return b ? b.getAttribute('data-maintab') : 'dashboard';
  }
  // Which sections' data each kind of page shows.
  function sectionsShownBy(tab){
    if(tab === 'activity') return { common:true, projects:true, technical:true, factory:true, site:true, office:true };
    var sec = ST.TAB_SECTION[tab];
    if(!sec){
      if(ST.ADMIN_TABS[tab]) return {};
      return { projects:true, technical:true, factory:true, site:true, office:true }; // dashboards & reports
    }
    var m = {}; m[sec] = true; m.factory = true;   // most pages also show fabrication progress
    return m;
  }
  function busy(){
    var el = document.activeElement;
    if(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) && el.closest && !el.closest('#stCover')) return true;
    if(document.querySelector('.modal-overlay.open')) return true;
    if(ST.engine && ST.engine.hasUnsaved()) return true;
    return false;
  }
  function saveRestore(tab){
    try{
      if(!tab){
        // A reload that happens before the page finished opening (e.g. the
        // one that picks up teammates' changes) must not replace the page
        // the person was going back to.
        var prev = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null');
        if(prev && Date.now() - prev.t < 120000 && document.documentElement.classList.contains('st-locked')) return;
      }
      sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ tab: tab || activeTab(), y: window.scrollY, t: Date.now() }));
    }catch(e){}
  }
  function doReload(tab){
    saveRestore(tab);
    lastReload = Date.now();
    try{ sessionStorage.setItem('st-last-reload', String(lastReload)); }catch(e){}
    location.reload();
  }

  ui.refresh = {
    onRemoteChange: function(ev){
      if(ev.mine) return;
      var tab = activeTab();
      var shown = sectionsShownBy(tab);
      if(ev.section === 'common' && tab !== 'activity') return;   // activity log: only matters on its own page
      if(!shown[ev.section]){ stale[ev.section] = true; return; }
      var who = ev.meta && ev.meta.name ? ev.meta.name : 'A teammate';
      var reason = who + ' updated ' + ST.sectionLabel(ev.section);
      var own = ST.TAB_SECTION[tab] === ev.section || (tab === 'activity' && ev.section === 'common');
      if(own){
        // The page you're working in: refresh by itself when you're not busy.
        ui.refresh.request(reason, false);
      } else {
        // Related data (e.g. fabrication progress shown on a Site page, or a
        // dashboard): don't interrupt — offer a refresh instead.
        stale[ev.section] = true;
        ui.needsAttention(reason + ' — tap to refresh', function(){ doReload(); });
      }
    },
    request: function(reason, isDashboard){
      if(pending) return;
      pending = true;
      var minGap = isDashboard ? 30000 : 5000;
      try{ lastReload = Math.max(lastReload, Number(sessionStorage.getItem('st-last-reload') || 0)); }catch(e){}
      var shownAttention = false;
      (function attempt(){
        if(busy()){
          if(!shownAttention){
            shownAttention = true;
            ui.needsAttention(reason + ' — tap to refresh', function(){ doReload(); });
          }
          return setTimeout(attempt, 2500);
        }
        var wait = lastReload + minGap - Date.now();
        if(wait > 0) return setTimeout(attempt, wait);
        ui.toast(reason + ' — refreshing…');
        setTimeout(function(){ if(busy()) return attempt(); doReload(); }, 900);
      })();
    },
    staleFor: function(tab){
      var shown = sectionsShownBy(tab);
      return Object.keys(stale).some(function(s){ return shown[s]; });
    },
    reloadInto: function(tab){ doReload(tab); },
    reloadNow: function(){ doReload(); },
    restore: function(){
      var r = null;
      try{ r = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null'); sessionStorage.removeItem(RESTORE_KEY); }catch(e){}
      if(!r || Date.now() - r.t > 120000) return;
      var btn = document.querySelector('.maintab-btn[data-maintab="' + r.tab + '"]');
      if(btn && !btn.classList.contains('active') && !btn.classList.contains('st-hidden')) btn.click();
      setTimeout(function(){ window.scrollTo(0, r.y || 0); }, 60);
    }
  };
})();
