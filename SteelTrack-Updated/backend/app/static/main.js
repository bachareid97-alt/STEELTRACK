(function(){
  const $ = (id)=>document.getElementById(id);
  let token = null;
  let ws = null;
  let store = {};

  async function login(){
    const username = $('username').value;
    const password = $('password').value;
    const res = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password})});
    if(!res.ok){ alert('Login failed'); return; }
    const data = await res.json();
    token = data.access_token;
    localStorage.setItem('steeltrack_token', token);
    startWS();
    $('appArea').style.display = 'block';
  }

  function startWS(){
    if(!token) token = localStorage.getItem('steeltrack_token');
    if(!token) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + token);
    ws.onopen = ()=>console.log('ws open');
    ws.onmessage = (ev)=>{
      try{ const msg = JSON.parse(ev.data); handleMsg(msg); }catch(e){}
    };
    ws.onclose = ()=>console.log('ws closed');
  }

  function handleMsg(msg){
    if(msg.type === 'hello'){
      store = msg.store || {};
      renderStore();
    } else if(msg.type === 'set'){
      store[msg.key] = msg.value;
      renderStore();
    } else if(msg.type === 'remove'){
      delete store[msg.key];
      renderStore();
    }
  }

  function renderStore(){
    $('store').textContent = JSON.stringify(store, null, 2);
  }

  async function setKV(){
    const key = $('kvKey').value;
    const value = $('kvValue').value;
    if(!key) return alert('key required');
    const msg = {type:'set', key, value};
    if(ws && ws.readyState === 1){ ws.send(JSON.stringify(msg)); }
    else {
      // fallback: call REST API (not implemented yet) — optimistic local update
      store[key] = value; renderStore();
    }
  }

  $('btnLogin').addEventListener('click', login);
  $('btnSet').addEventListener('click', setKV);
  $('btnReload').addEventListener('click', ()=>{ if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'noop'})); else alert('ws not connected');});

  // auto start if token present
  if(localStorage.getItem('steeltrack_token')){ $('username').value=''; $('password').value=''; $('btnLogin').click(); }
})();
