/* =====================================================================
   SteelTrack Cloud — administrator tools (the "Users" page)
   ---------------------------------------------------------------------
   1. Team members: approve sign-ups, set None / View / Edit per section,
      make admins, disable accounts.
   2. Move existing data to the cloud (one-time migration) from:
        - this browser's saved data and attachments
        - the old app file (.html) — has the master assembly list and
          the erection-drawing PDFs that used to be built into the page
        - the old same-Wi-Fi server's steeltrack_data.json
   3. Backups: download everything as one file; restore a key from any
      of the last 14 days.
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};
  var C = ST.codec;
  var backend = null, access = null, h = null;
  var usersCache = {};
  var unsubUsers = null;

  function levelSelect(value, onchange){
    var s = h('select', { class:'lvl-' + (value || 'none') });
    [['none','No access'],['view','View only'],['edit','Can edit']].forEach(function(o){
      var opt = h('option', { value:o[0], text:o[1] });
      if(o[0] === (value || 'none')) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', function(){ s.className = 'lvl-' + s.value; if(onchange) onchange(s.value); });
    return s;
  }

  var PRESETS = [
    { label:'Site engineer', perms:{ projects:'view', technical:'view', factory:'view', site:'edit', office:'none' } },
    { label:'Factory / QC',  perms:{ projects:'view', technical:'view', factory:'edit', site:'view', office:'none' } },
    { label:'Technical office', perms:{ projects:'view', technical:'edit', factory:'view', site:'view', office:'none' } },
    { label:'Office / HR / Accounts', perms:{ projects:'view', technical:'none', factory:'view', site:'view', office:'edit' } },
    { label:'Manager (view all)', perms:{ projects:'view', technical:'view', factory:'view', site:'view', office:'view' } }
  ];

  function saveProfile(uid, profile){
    profile.updated = Date.now();
    profile.updatedBy = access.uid();
    return Promise.all([
      backend.set('users/' + uid, profile),
      backend.setProfileMirror(uid, profile)
    ]);
  }

  // ------------------------------------------------------------------
  // 1. Team members
  // ------------------------------------------------------------------
  function renderUsers(box){
    box.innerHTML = '';
    var list = Object.keys(usersCache).map(function(uid){ return Object.assign({ uid:uid }, usersCache[uid]); });
    list.sort(function(a, b){
      var ra = !a.approved ? 0 : a.disabled ? 2 : 1, rb = !b.approved ? 0 : b.disabled ? 2 : 1;
      return ra - rb || String(a.name || a.email).localeCompare(String(b.name || b.email));
    });
    var pendingCount = list.filter(function(u){ return !u.approved; }).length;

    box.appendChild(h('h3', { text:'Team members' + (pendingCount ? '  ·  ' + pendingCount + ' waiting for approval' : '') }));
    box.appendChild(h('p', { class:'st-help', text:'Everyone signs up with their own email at the app’s address, then appears here. Choose what each person can do per section and press Save. Changes apply to them instantly. Tip: Site pages show fabrication progress, so site staff need at least “View only” on Factory.' }));

    var head = h('tr', {}, [ h('th', { text:'Person' }), h('th', { text:'Status' }), h('th', { text:'' }), h('th', { text:'Quick set' }) ]
      .concat(ST.SECTIONS.map(function(s){ return h('th', { text:s.label, title:s.desc }); }))
      .concat([ h('th', { text:'' }) ]));
    var tbody = h('tbody');
    list.forEach(function(u){ tbody.appendChild(userRow(u)); });
    if(!list.length) tbody.appendChild(h('tr', {}, [ h('td', { colspan:'10', text:'No one has signed up yet.' }) ]));
    box.appendChild(h('div', { class:'st-table-wrap' }, [ h('table', { class:'st-table' }, [ h('thead', {}, [head]), tbody ]) ]));
  }

  function userRow(u){
    var perms = Object.assign({}, u.perms || {});
    var isMe = u.uid === access.uid();
    var status = !u.approved ? h('span', { class:'st-badge pending', text:'Waiting' })
               : u.disabled ? h('span', { class:'st-badge disabled', text:'Disabled' })
               : h('span', { class:'st-badge active', text:'Active' });
    var adminBox = h('input', { type:'checkbox' });
    adminBox.checked = !!u.admin;
    if(isMe) adminBox.disabled = true;     // don't lock yourself out
    var selects = {};
    var cells = ST.SECTIONS.map(function(s){
      selects[s.id] = levelSelect(perms[s.id] || 'none', function(v){ perms[s.id] = v; });
      var full = h('span', { class:'st-full', text:'Full access' });
      var td = h('td', {}, [ selects[s.id], full ]);
      function sync(){ var a = adminBox.checked; selects[s.id].style.display = a ? 'none' : ''; full.style.display = a ? '' : 'none'; }
      adminBox.addEventListener('change', sync);
      sync();
      return td;
    });
    var presetSel = h('select', { title:'Quick preset' }, [ h('option', { value:'', text:'Preset…' }) ]
      .concat(PRESETS.map(function(p, i){ return h('option', { value:String(i), text:p.label }); })));
    presetSel.addEventListener('change', function(){
      var p = PRESETS[+presetSel.value];
      if(!p) return;
      ST.SECTION_IDS.forEach(function(id){ perms[id] = p.perms[id]; selects[id].value = p.perms[id]; selects[id].className = 'lvl-' + p.perms[id]; });
      presetSel.value = '';
    });

    function save(changes, okText){
      var prof = {
        email: u.email || '', name: u.name || '', created: u.created || Date.now(),
        approved: !!u.approved, admin: !!adminBox.checked, disabled: !!u.disabled, perms: perms
      };
      Object.assign(prof, changes || {});
      return saveProfile(u.uid, prof).then(function(){ ST.ui.toast(okText || 'Saved ✔'); })
        .catch(function(err){ ST.ui.toast('Could not save: ' + (err && err.message || err)); });
    }

    var acts = [];
    if(!u.approved){
      acts.push(h('button', { class:'st-btn st-btn-sm st-btn-ok', text:'Approve', onclick:function(){
        var anySet = ST.SECTION_IDS.some(function(id){ return perms[id] && perms[id] !== 'none'; });
        if(!anySet && !adminBox.checked && !confirm('This person has no access to any section yet. Approve anyway?')) return;
        save({ approved:true }, (u.name || u.email) + ' approved');
      } }));
    } else {
      acts.push(h('button', { class:'st-btn st-btn-sm', text:'Save', onclick:function(){ save(); } }));
    }
    if(!isMe && u.approved){
      acts.push(u.disabled
        ? h('button', { class:'st-btn st-btn-sm st-btn-ok', text:'Enable', onclick:function(){ save({ disabled:false }, 'Enabled'); } })
        : h('button', { class:'st-btn st-btn-sm st-btn-danger', text:'Disable', onclick:function(){
            if(confirm('Turn off ' + (u.name || u.email) + '’s access? They will be signed out of the app immediately.')) save({ disabled:true }, 'Disabled');
          } }));
    }

    return h('tr', {}, [
      h('td', {}, [ h('div', { style:'font-weight:600', text:u.name || '(no name)' }), h('div', { style:'color:#8b98b0;font-size:11.5px', text:u.email || '' }) ]),
      h('td', {}, [ h('div', {}, [ status ]), u.admin ? h('div', {}, [ h('span', { class:'st-badge admin', text:'Admin', style:'margin-left:0' }) ]) : null ]),
      h('td', {}, [ h('div', { class:'st-row-actions' }, acts) ]),
      h('td', {}, [ presetSel ])
    ].concat(cells).concat([
      h('td', {}, [ h('label', { style:'display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap' }, [ adminBox, 'Admin' ]) ])
    ]));
  }

  // ------------------------------------------------------------------
  // 2. Migration
  // ------------------------------------------------------------------
  var sources = { browser:null, html:null, server:null };   // key -> raw string ; plus .files
  var SRC_LABEL = { cloud:'Keep cloud', browser:'This browser', html:'Old app file', server:'Server file' };

  function readFileText(file){
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){ resolve(r.result); };
      r.onerror = function(){ reject(r.error); };
      r.readAsText(file);
    });
  }

  function loadBrowserSource(){
    var keys = {}, files = [];
    Object.keys(ST.KEY_SECTION).forEach(function(k){
      var v = ST.rawLocal.get(k);
      if(v !== null && !C.isEmptyRaw(v)) keys[k] = v;
    });
    // Erection drawings that fell back to localStorage
    for(var i=0;i<localStorage.length;i++){
      var lk = localStorage.key(i);
      if(lk && lk.indexOf('erectionDrawing:') === 0) files.push({ ns:'erection', key: lk.slice(16), data: ST.rawLocal.get(lk) });
    }
    var jobs = Object.keys(ST.FILE_NS_SECTION).map(function(ns){
      var dbName = ST.FILE_NS_DB[ns] || ns, store = ST.FILE_NS_STORE[ns] || 'files';
      return ST.idb.all(dbName, store).then(function(all){
        Object.keys(all).forEach(function(k){
          var v = all[k];
          if(typeof v !== 'string' || !v) return;
          if(ns === 'erection'){
            if(k.indexOf('erectionDrawing:') !== 0) return;
            files.push({ ns:'erection', key:k.slice(16), data:v });
          } else {
            files.push({ ns:ns, key:k, data:v });
          }
        });
      });
    });
    return Promise.all(jobs).then(function(){
      var canList = !!(window.indexedDB && indexedDB.databases);
      return { keys:keys, files:files, note: canList ? '' : 'This browser can’t list its saved attachments — use Chrome or Edge to include them.' };
    });
  }

  function loadHtmlSource(text){
    var keys = {}, files = [];
    function block(id){
      var re = new RegExp('<script type="application/json" id="' + id + '">([\\s\\S]*?)<\\/script>');
      var m = re.exec(text);
      return m ? m[1] : null;
    }
    Object.keys(ST.LEGACY_SEEDS).forEach(function(id){
      var raw = block(id);
      if(raw === null) return;
      try{ JSON.parse(raw); }catch(e){ return; }
      if(!C.isEmptyRaw(raw)) keys[ST.LEGACY_SEEDS[id]] = raw;
    });
    var dr = block('drawingsSeed');
    if(dr){
      try{
        var d = JSON.parse(dr);
        Object.keys(d).forEach(function(job){ if(d[job]) files.push({ ns:'erection', key:job, data:d[job] }); });
      }catch(e){}
    }
    if(!keys['steeltrack-baselist-v1']) throw new Error('This file doesn’t contain the SteelTrack assembly list — pick the old FACTORY_TRACK_AND_STOCK .html file.');
    return { keys:keys, files:files, note:'' };
  }

  function loadServerSource(text){
    var obj = JSON.parse(text);
    if(!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Not a SteelTrack server data file.');
    var keys = {}, files = [];
    Object.keys(obj).forEach(function(k){
      var v = obj[k];
      if(typeof v !== 'string') return;
      if(k.indexOf('erectionDrawing:') === 0){ files.push({ ns:'erection', key:k.slice(16), data:v }); return; }
      if(ST.KEY_SECTION[k] && !C.isEmptyRaw(v)) keys[k] = v;
    });
    if(!Object.keys(keys).length && !files.length) throw new Error('No SteelTrack data found in this file.');
    return { keys:keys, files:files, note:'' };
  }

  function renderMigration(box){
    box.innerHTML = '';
    box.appendChild(h('h3', { text:'Move existing data to the cloud' }));
    box.appendChild(h('p', { class:'st-help', html:
      'Do this once. Load any of the three sources below, check the table, then press <b>Upload to cloud</b>. ' +
      'Anything already in the cloud is backed up first, so nothing is lost. ' +
      'For <b>This browser</b>: open this new app the same way you used to open the old one (same computer, same browser, same address or folder) — browsers only share saved data with the same address.' }));

    var status = {};
    function sourceBox(id, title, desc, input){
      status[id] = h('div', { class:'st-src-status' });
      return h('div', { class:'st-source' }, [ h('b', { text:title }), h('div', { text:desc }), input, status[id] ]);
    }
    var browserBtn = h('button', { class:'st-btn st-btn-sm', style:'margin-top:8px', text:'Read this browser’s data' });
    var htmlInput = h('input', { type:'file', accept:'.html,.htm', style:'margin-top:8px;max-width:100%' });
    var serverInput = h('input', { type:'file', accept:'.json', style:'margin-top:8px;max-width:100%' });
    box.appendChild(h('div', { class:'st-sources' }, [
      sourceBox('browser', 'This browser', 'Everything saved on this computer, including attachments.', browserBtn),
      sourceBox('html', 'Old app file (.html)', 'Your latest FACTORY_TRACK_AND_STOCK file — has the master assembly list and erection drawings.', htmlInput),
      sourceBox('server', 'Old server data file', 'steeltrack_data.json from the folder where server.py runs.', serverInput)
    ]));
    var tableBox = h('div');
    box.appendChild(tableBox);

    function loaded(id, src){
      sources[id] = src;
      status[id].style.color = '#86efac';
      status[id].textContent = '✔ ' + Object.keys(src.keys).length + ' data sets, ' + src.files.length + ' files' + (src.note ? ' — ' + src.note : '');
      renderPlan(tableBox);
    }
    function failed(id, err){
      status[id].style.color = '#fca5a5';
      status[id].textContent = err && err.message || String(err);
    }
    browserBtn.addEventListener('click', function(){
      status.browser.textContent = 'Reading…';
      loadBrowserSource().then(function(s){ loaded('browser', s); }).catch(function(e){ failed('browser', e); });
    });
    htmlInput.addEventListener('change', function(){
      var f = htmlInput.files[0]; if(!f) return;
      status.html.textContent = 'Reading ' + f.name + '…';
      readFileText(f).then(loadHtmlSource).then(function(s){ loaded('html', s); }).catch(function(e){ failed('html', e); });
    });
    serverInput.addEventListener('change', function(){
      var f = serverInput.files[0]; if(!f) return;
      status.server.textContent = 'Reading ' + f.name + '…';
      readFileText(f).then(loadServerSource).then(function(s){ loaded('server', s); }).catch(function(e){ failed('server', e); });
    });
    renderPlan(tableBox);
  }

  function renderPlan(box){
    box.innerHTML = '';
    var srcIds = ['browser','html','server'].filter(function(id){ return sources[id]; });
    if(!srcIds.length) return;
    var keys = {};
    srcIds.forEach(function(id){ Object.keys(sources[id].keys).forEach(function(k){ keys[k] = true; }); });
    var choice = {};
    var rows = Object.keys(keys).sort(function(a, b){
      return ST.KEY_SECTION[a].localeCompare(ST.KEY_SECTION[b]) || a.localeCompare(b);
    }).map(function(k){
      var cloudRaw = ST.engine.cloudNode(k) ? C.nodeToRaw(ST.engine.cloudNode(k)) : null;
      var opts = [];
      if(cloudRaw !== null && !C.isEmptyRaw(cloudRaw)) opts.push({ id:'cloud', raw:cloudRaw });
      srcIds.forEach(function(id){ if(sources[id].keys[k]) opts.push({ id:id, raw:sources[id].keys[k] }); });
      // Default: keep what the cloud has; otherwise take the source with the most data.
      var def = opts[0].id === 'cloud' ? 'cloud' : opts.slice().sort(function(a, b){ return C.describeRaw(b.raw).bytes - C.describeRaw(a.raw).bytes; })[0].id;
      choice[k] = def;
      var name = 'mig_' + k.replace(/[^a-z0-9]/gi, '_');
      var cells = ['cloud'].concat(srcIds).map(function(id){
        var o = opts.filter(function(x){ return x.id === id; })[0];
        if(!o) return h('td', { class:'st-mig-src', style:'color:#475569', text:'—' });
        var r = h('input', { type:'radio', name:name, value:id });
        r.checked = id === def;
        r.addEventListener('change', function(){ if(r.checked) choice[k] = id; });
        return h('td', { class:'st-mig-src' }, [ h('label', {}, [ r, ' ' + C.describeRaw(o.raw).text ]) ]);
      });
      return h('tr', { class:'st-mig-row' }, [ h('td', { text:k }), h('td', { text:ST.sectionLabel(ST.KEY_SECTION[k]) }) ].concat(cells));
    });

    var allFiles = [];
    srcIds.forEach(function(id){ allFiles = allFiles.concat(sources[id].files); });
    var seen = {};
    allFiles = allFiles.filter(function(f){ var id = f.ns + '|' + f.key; if(seen[id]) return false; seen[id] = true; return true; });
    var filesBox = h('input', { type:'checkbox' });
    filesBox.checked = allFiles.length > 0;
    var totalMB = allFiles.reduce(function(s, f){ return s + (f.data ? f.data.length * 0.75 : 0); }, 0) / 1048576;

    var go = h('button', { class:'st-btn st-btn-primary', style:'width:auto;margin-top:12px', text:'Upload to cloud' });
    var log = h('div', { class:'st-help', style:'margin-top:10px;white-space:pre-line' });
    box.appendChild(h('div', { class:'st-table-wrap' }, [ h('table', { class:'st-table' }, [
      h('thead', {}, [ h('tr', {}, [ h('th', { text:'Data' }), h('th', { text:'Section' }) ]
        .concat(['cloud'].concat(srcIds).map(function(id){ return h('th', { text:SRC_LABEL[id] }); }))) ]),
      h('tbody', {}, rows)
    ]) ]));
    box.appendChild(h('p', { class:'st-help', style:'margin-top:8px', text:'Each row shows how many items each source holds. The biggest is picked by default because it is usually the most up to date; change it if you know better.' }));
    box.appendChild(h('label', { style:'display:block;font-size:13px;margin-top:6px' }, [ filesBox, ' Also upload ' + allFiles.length + ' attached files (' + totalMB.toFixed(1) + ' MB)' ]));
    box.appendChild(go);
    box.appendChild(log);

    go.addEventListener('click', function(){
      var todo = Object.keys(choice).filter(function(k){ return choice[k] !== 'cloud'; });
      if(!todo.length && !(filesBox.checked && allFiles.length)) return ST.ui.toast('Nothing to upload — everything is set to “Keep cloud”.');
      if(!confirm('Upload ' + todo.length + ' data sets' + (filesBox.checked ? ' and ' + allFiles.length + ' files' : '') + ' to the cloud? The whole team will see them.')) return;
      go.disabled = true;
      var stamp = 'migration-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      var done = 0, failed = 0;
      function line(t){ log.textContent += t + '\n'; }
      log.textContent = '';
      var chain = Promise.resolve();
      todo.forEach(function(k){
        chain = chain.then(function(){
          var src = choice[k];
          var raw = sources[src].keys[k];
          var extra = {};
          var old = ST.engine.cloudNode(k);
          if(old){
            extra['backups/' + stamp + '/' + ST.KEY_SECTION[k] + '/' + C.encSeg(k)] = old;
            extra['backupDays/' + stamp] = true;
          }
          return ST.engine.writeWhole(k, raw, extra).then(function(){ done++; line('✔ ' + k + ' (from ' + SRC_LABEL[src] + ')'); })
            .catch(function(err){ failed++; line('✖ ' + k + ': ' + (err && err.message || err)); });
        });
      });
      if(filesBox.checked){
        allFiles.forEach(function(f, i){
          chain = chain.then(function(){
            line('Uploading file ' + (i + 1) + ' of ' + allFiles.length + '…');
            return ST.files.put(f.ns, f.key, f.data).then(function(ok){ if(ok) done++; else failed++; });
          });
        });
      }
      chain.then(function(){
        line('\nFinished: ' + done + ' uploaded' + (failed ? ', ' + failed + ' failed (see above)' : '') + '.');
        if(!failed){
          line('The page will reload with the cloud data in a few seconds.');
          setTimeout(function(){ ST.ui.refresh.reloadNow(); }, 4000);
        }
        go.disabled = false;
      });
    });
  }

  // ------------------------------------------------------------------
  // 3. Backups
  // ------------------------------------------------------------------
  function renderBackups(box){
    box.innerHTML = '';
    box.appendChild(h('h3', { text:'Backups' }));
    box.appendChild(h('p', { class:'st-help', text:'The cloud keeps the previous version of each data set every day for ' + ST.BACKUP_DAYS_KEPT + ' days, plus a copy before any migration. Attached files are stored separately in Cloud Storage. You can also download everything as one file to keep on your own computer.' }));
    var dl = h('button', { class:'st-btn', text:'⬇ Download all cloud data (.json)' });
    dl.addEventListener('click', function(){
      dl.disabled = true; dl.textContent = 'Preparing…';
      backend.get('data').then(function(data){
        var out = {};
        Object.keys(data || {}).forEach(function(sec){
          Object.keys(data[sec] || {}).forEach(function(ek){
            var rec = data[sec][ek];
            if(rec && rec.v !== undefined) out[C.decSeg(ek)] = C.nodeToRaw(rec.v);
          });
        });
        var blob = new Blob([JSON.stringify(out)], { type:'application/json' });
        var a = h('a', { href:URL.createObjectURL(blob), download:'steeltrack-cloud-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
        document.body.appendChild(a); a.click(); a.remove();
        ST.ui.toast('Backup downloaded. It can be loaded back with the “Old server data file” option above.');
      }).catch(function(err){ ST.ui.toast('Could not download: ' + (err && err.message || err)); })
        .then(function(){ dl.disabled = false; dl.textContent = '⬇ Download all cloud data (.json)'; });
    });
    box.appendChild(dl);

    var restoreBox = h('div', { style:'margin-top:14px' });
    box.appendChild(restoreBox);
    backend.get('backupDays').then(function(days){
      var list = Object.keys(days || {}).sort().reverse();
      if(!list.length){ restoreBox.appendChild(h('p', { class:'st-help', text:'No daily backups yet — they start with the first change each day.' })); return; }
      var daySel = h('select', {}, list.map(function(d){ return h('option', { value:d, text:d }); }));
      var keySel = h('select', {}, Object.keys(ST.KEY_SECTION).sort().map(function(k){ return h('option', { value:k, text:k + ' (' + ST.sectionLabel(ST.KEY_SECTION[k]) + ')' }); }));
      var btn = h('button', { class:'st-btn st-btn-sm', text:'Restore this version' });
      btn.addEventListener('click', function(){
        var day = daySel.value, k = keySel.value;
        backend.get('backups/' + day + '/' + ST.KEY_SECTION[k] + '/' + C.encSeg(k)).then(function(node){
          if(!node){ ST.ui.toast('No backup of ' + k + ' on ' + day + '.'); return; }
          var raw = C.nodeToRaw(node);
          if(!confirm('Replace the current ' + k + ' for the whole team with the version from ' + day + ' (' + C.describeRaw(raw).text + ')? The current version is backed up first.')) return;
          var extra = {}, stamp = 'restore-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          var cur = ST.engine.cloudNode(k);
          if(cur){ extra['backups/' + stamp + '/' + ST.KEY_SECTION[k] + '/' + C.encSeg(k)] = cur; extra['backupDays/' + stamp] = true; }
          return ST.engine.writeWhole(k, raw, extra).then(function(){
            ST.ui.toast('Restored ' + k + ' from ' + day + '. Reloading…');
            setTimeout(function(){ ST.ui.refresh.reloadNow(); }, 1500);
          });
        }).catch(function(err){ ST.ui.toast('Restore failed: ' + (err && err.message || err)); });
      });
      restoreBox.appendChild(h('div', { class:'st-row-actions', style:'align-items:center' }, [ h('span', { text:'Restore' }), keySel, h('span', { text:'from' }), daySel, btn ]));
    }).catch(function(){});
  }

  // Delete daily backups older than BACKUP_DAYS_KEPT (migration/restore copies are kept).
  function pruneBackups(){
    var cutoff = new Date(Date.now() - ST.BACKUP_DAYS_KEPT * 86400000);
    var cut = cutoff.getFullYear() + '-' + String(cutoff.getMonth()+1).padStart(2,'0') + '-' + String(cutoff.getDate()).padStart(2,'0');
    backend.get('backupDays').then(function(days){
      var u = {};
      Object.keys(days || {}).forEach(function(d){
        if(/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cut){ u['backups/' + d] = null; u['backupDays/' + d] = null; }
      });
      if(Object.keys(u).length) return backend.update(u);
    }).catch(function(){});
  }

  // ------------------------------------------------------------------
  ST.admin = {
    init: function(be, acc){
      backend = be; access = acc; h = ST.ui.h;
      if(!access.isAdmin()) return;
      ST.ui.onReady(function(){
        var panel = document.getElementById('maintab-users');
        if(!panel) return;
        panel.innerHTML = '';
        var root = h('div', { class:'st-admin' });
        var usersBox = h('div', { class:'st-panel' }, [ h('p', { class:'st-help', text:'Loading team…' }) ]);
        var migBox = h('div', { class:'st-panel' });
        var bkBox = h('div', { class:'st-panel' });
        root.appendChild(usersBox); root.appendChild(migBox); root.appendChild(bkBox);
        panel.appendChild(root);
        unsubUsers = backend.on('users', function(all){
          usersCache = all || {};
          renderUsers(usersBox);
          var waiting = Object.keys(usersCache).filter(function(k){ return !usersCache[k].approved; }).length;
          var btnLabel = document.querySelector('.maintab-btn[data-maintab="users"] .sb-label');
          if(btnLabel) btnLabel.textContent = waiting ? 'Users (' + waiting + ' waiting)' : 'Users';
        }, function(err){ usersBox.innerHTML = ''; usersBox.appendChild(h('p', { class:'st-help', text:'Could not load users: ' + (err && err.message || err) })); });
        renderMigration(migBox);
        renderBackups(bkBox);
      });
      setTimeout(pruneBackups, 15000);
    }
  };
})();
