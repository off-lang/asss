// Interactive map. Site data format and room terminology referenced from
// Animesss Labyrinth Map 10.45 by VladLIO (MIT). Cloud reads are user-triggered.
(() => {
  'use strict';
  const labels = {
    start:'Старт', empty:'Пусто', reward:'Награда', jackpot:'Джекпот', penalty:'Штраф',
    quiz:'Викторина', puzzle:'Пазл', mini_boss:'Мини-босс', hard_boss:'Хард-босс',
    reward_card:'Карта', luck_altar:'Алтарь', card_trader:'Торговец', relic_room:'Реликвия',
    collection:'Коллекция', locked_chest:'Сундук', room_trap:'Ловушка игрока', room_gift:'Подарок игрока',
    mimic_chest:'Мимик', recovery_room:'Лечение', spiritual_teleport:'Телепорт', trap_back:'Откат',
    guardian_user:'Страж', guardian_club:'Страж клуба', personal_mine:'Шахта', foreign_mine:'Чужая шахта',
    club_war_room:'Битва клубов', echo_room:'Отголосок', fate_room:'Выбор судьбы',
    resonance_room:'Резонанс', kobold_room:'Кобольд', fatigue:'Усталость', unknown:'Неизвестно'
  };
  const key = p => `${p.x},${p.y}`;
  const icons = {start:'⌂',empty:'·',reward:'◆',jackpot:'★',penalty:'!',quiz:'?',puzzle:'🧩',
    mini_boss:'⚔',hard_boss:'⚔',reward_card:'▣',luck_altar:'⚱',card_trader:'🛒',relic_room:'◇',
    collection:'▤',locked_chest:'🔒',room_trap:'!',room_gift:'🎁',mimic_chest:'👅',
    recovery_room:'✚',spiritual_teleport:'🌀',trap_back:'↶',guardian_user:'♜',guardian_club:'♜',
    personal_mine:'⛏',foreign_mine:'⛏',echo_room:'👣',fate_room:'⚖',resonance_room:'◎'};
  function point(p) {
    return p && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y) &&
      Math.abs(p.x) <= 1000000 && Math.abs(p.y) <= 1000000 ? {x:p.x,y:p.y} : null;
  }
  function normalize(raw) {
    const current = point(raw?.current);
    if (!current || !Array.isArray(raw.steps) || raw.steps.length > 10000) return null;
    return {current, steps: raw.steps.filter(point).map(s => ({...point(s),
      event: typeof s.event === 'string' && /^[a-z0-9_]{1,64}$/.test(s.event) ? s.event : 'unknown'}))};
  }
  function merge(rooms, steps) {
    const result = {...rooms};
    for (const s of steps) result[key(s)] = {...result[key(s)], ...s};
    // Bound local history to avoid exhausting extension storage.
    return Object.fromEntries(Object.entries(result).slice(-20000));
  }
  function label(event) { return labels[event] || labels[event?.replace(/_result$/, '')] || event || 'Неизвестно'; }
  function parseAccRows(doc) {
    function number(text,signed) {
      const cleaned=String(text).replace(/[\s\u00a0\u202f]/g,'').replace(/\u2212/g,'-');
      if(!(signed?/^[+-]?\d+$/:/^\d+$/).test(cleaned))return null;
      const value=Number(cleaned);return Number.isSafeInteger(value)?value:null;
    }
    return Array.from(doc.querySelectorAll('.ncard-transactions__table tbody tr')).slice(0,100).flatMap(tr=>{
      const cells=tr.querySelectorAll('td');if(cells.length<2)return [];
      const delta=number(cells[0].textContent,true),after=number(cells[1].textContent,false);
      return delta===null||after===null?[]:[{acc_delta:delta,acc_after:after}];
    });
  }
  if (typeof module !== 'undefined') { module.exports = {point, normalize, merge, key, label, parseAccRows}; return; }
  if (!/^\/labyrinth(?:\/|$)/.test(location.pathname)) return;
  let rooms = {}, current = null, selected = null, center = {x:0,y:0}, scale = 44, signature = '', loaded = false;
  let storageKey, writeTimer, closed = false, dragging = null, moved = false, viewPositioned = false;
  const enabledKey = 'animesss.localLabyrinth.enabled';
  let enabled = false;
  let cloudRooms = {}, cloudJob = 0, cloudLoading = false, username = '';
  let cacheDb, cacheUpdatedAt = 0, lastCloudArea = null;
  let pendingCacheRooms = {};
  const cloudCacheLimit = 200000;
  function openCache() {
    if (!cacheDb) cacheDb = new Promise((resolve, reject) => {
      const request = indexedDB.open('animesss-helper-shared-map-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('maps');
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('База кэша занята другой вкладкой'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); cacheDb = null; };
        resolve(db);
      };
    }).catch(error => { cacheDb = null; throw error; });
    return cacheDb;
  }
  function unpackCache(record) {
    const result = {};
    if (record?.version !== 1 || !Array.isArray(record.rooms)) return result;
    for (const row of record.rooms.slice(-cloudCacheLimit)) {
      if (!Array.isArray(row)) continue;
      const p = point({x:row[0],y:row[1]});
      if (p && typeof row[2] === 'string' && /^[a-z0-9_]{1,64}$/.test(row[2])) result[key(p)] = {...p,event:row[2]};
    }
    return result;
  }
  async function cacheAccess(additions, area) {
    if (!storageKey) throw new Error('Не определён профиль для кэша');
    const db = await openCache();
    return new Promise((resolve, reject) => {
      const writing = additions !== undefined;
      const tx = db.transaction('maps', writing ? 'readwrite' : 'readonly');
      const store = tx.objectStore('maps'), request = store.get(storageKey);
      let result;
      request.onsuccess = () => {
        result = request.result;
        if (!writing) return;
        // Read and merge inside one transaction so concurrent tabs do not erase areas.
        const merged = unpackCache(result);
        for (const room of additions) { delete merged[key(room)]; merged[key(room)] = room; }
        result = {version:1, updatedAt:Date.now(), area,
          rooms:Object.values(merged).slice(-cloudCacheLimit).map(r => [r.x,r.y,r.event])};
        store.put(result, storageKey);
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Ошибка записи кэша'));
    });
  }
  function showCacheStatus(error) {
    $('cacheStatus').textContent = error ? `Кэш не сохранён: ${error.message}. Не закрывайте вкладку, если хотите сохранить показанную карту.` :
      `Кэш: ${Object.keys(cloudRooms).length} комнат${cacheUpdatedAt ? ` • Последнее пополнение: ${new Date(cacheUpdatedAt).toLocaleString()}` : ''}. Комнаты могли измениться. Лимит — 200 000 комнат.`;
  }
  const viewRooms = () => ({...cloudRooms,...rooms});
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>
    :host{font:14px/1.5 system-ui;color:#edf0ff}*{box-sizing:border-box}
    button,input{font:inherit}button{cursor:pointer;color:#edf0ff;background:#303851;border:1px solid #616d8c;border-radius:6px;padding:8px 12px}
    button:hover{background:#45516c}button:focus-visible,input:focus-visible{outline:3px solid #eec673;outline-offset:2px}
    #launcher{position:fixed;left:18px;bottom:24px;z-index:100000;display:flex;gap:6px}#launch{background:#303851;box-shadow:0 3px 16px #0008}button:disabled{opacity:.5;cursor:default}[hidden]{display:none!important}
    dialog{color:#edf0ff;background:#202638;border:1px solid #616d8c;border-radius:12px;padding:0;width:min(1100px,94vw);max-width:94vw;height:82vh;max-height:92vh}
    dialog::backdrop{background:#080d19b8}header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #45516c}h2{font-size:19px;margin:0;flex:1}
    dialog[open]{display:flex;flex-direction:column}header,#tools,#coordinates,#coordinateStatus,#status,footer,#hint{flex-shrink:0}
    #coordinates{display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding:0 18px 10px}#coordinates label{display:flex;gap:5px;align-items:center}#coordinates input{width:100px;min-width:70px;flex:none}#coordinateStatus{padding:0 18px;color:#eec673;font-size:12px}
    #tools{display:flex;gap:7px;flex-wrap:wrap;padding:10px 18px}#status{padding:0 18px 10px;color:#bcc7e2;font-size:13px}
    #view{flex:1;min-height:80px;background:#151b2a;position:relative;overflow:hidden;touch-action:none;cursor:grab}
    #view:active{cursor:grabbing}#grid{position:absolute;inset:0}#grid button{position:absolute;padding:0;border-radius:4px;font-size:12px;line-height:1.2;overflow:hidden}
    #grid .here{outline:3px solid #eec673;outline-offset:1px}#grid .selected{border:2px solid white}
    footer{padding:12px 18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}#details{width:100%;min-height:21px}input{min-width:100px;flex:1;color:#fff;background:#151b2a;border:1px solid #616d8c;border-radius:5px;padding:8px}
    #hint{padding:0 18px 10px;color:#bcc7e2;font-size:12px}@media(max-width:550px){h2{font-size:16px}#tools{padding:8px}button{padding:7px}#view{height:calc(100% - 290px)}}
  </style><div id="launcher"><button id="launch" hidden>🧭 Карта лабиринта</button><button id="toggle" disabled aria-pressed="false">Лабиринт: загрузка…</button></div>
  <dialog aria-labelledby="title"><header><h2 id="title">Карта вашего путешествия</h2><button id="close" aria-label="Закрыть карту">✕</button></header>
  <div id="tools"><button id="minus" aria-label="Уменьшить">−</button><button id="plus" aria-label="Увеличить">+</button><button id="here">Моя позиция</button><button id="all">Обзор загруженного</button><button id="nearby">Рядом ±100 — быстро</button><button id="cloud">Загрузить всю общую карту</button></div><div id="cloudStatus" role="status" style="padding:0 18px;font-size:12px;flex-shrink:0">labyrinthmap.uk: ник, идентификатор устройства; по запросу сервера — изменения и остатки ACC. «Рядом»: компактный обзор, обработка только ±100 клеток по X и Y.</div>
  <form id="coordinates"><label>X <input id="coordinateX" aria-label="Координата X" placeholder="0" maxlength="9"></label><label>Y <input id="coordinateY" aria-label="Координата Y" placeholder="0" maxlength="9"></label><button type="submit">Показать</button><button type="button" id="coordinateLoad">Загрузить ±100 от точки</button></form><div id="coordinateStatus" role="status"></div>
  <div id="status" role="status">Ожидаю данные лабиринта…</div><div id="view" tabindex="0" aria-label="Карта. Перетаскивайте или используйте стрелки"><div id="grid"></div></div>
  <footer><div id="details">Выберите комнату, чтобы добавить заметку.</div><input id="note" aria-label="Заметка о комнате" maxlength="160" placeholder="Заметка о комнате" disabled><button id="save" disabled>Сохранить</button></footer>
  <div id="hint">Золотая рамка — вы здесь. ★ — заметка. Старые комнаты могут измениться. Клик не расходует ход. На общем обзоре комнаты группируются: увеличьте масштаб для деталей.</div></dialog>`;
  const $ = id => shadow.getElementById(id), dialog = shadow.querySelector('dialog');
  const refresh = document.createElement('button');
  refresh.id = 'refreshCloud'; refresh.textContent = 'Обновить данные с сервера';
  $('tools').append(refresh);
  const cacheStatus = document.createElement('div');
  cacheStatus.id = 'cacheStatus'; cacheStatus.setAttribute('role','status');
  cacheStatus.style.cssText = 'padding:0 18px;font-size:12px;flex-shrink:0;color:#bcc7e2';
  $('cloudStatus').after(cacheStatus);
  const resizeObserver = new ResizeObserver(draw);
  function controlBridge() {
    window.postMessage({type:'animesss-local-map-control-v1',enabled:enabled && !closed},location.origin);
  }
  function applyEnabled(value) {
    enabled = value === true;
    signature = '';
    $('toggle').textContent = enabled ? 'Лабиринт: вкл' : 'Лабиринт: выкл';
    $('toggle').setAttribute('aria-pressed',String(enabled));
    $('launch').hidden = !enabled;
    if (enabled) resizeObserver.observe($('view'));
    else { cloudJob++; cloudLoading=false; refresh.disabled=false; $('cloud').disabled=false; $('nearby').disabled=false; $('coordinateLoad').disabled=false; dialog.close(); resizeObserver.disconnect(); $('grid').replaceChildren(); dragging = null; }
    controlBridge();
  }
  $('toggle').onclick = async () => {
    $('toggle').disabled = true;
    const next = !enabled;
    try { await chrome.storage.local.set({[enabledKey]:next}); applyEnabled(next); }
    catch(e) { fail(e); }
    finally { $('toggle').disabled = false; }
  };
  async function sendCloudRequest(message) {
    const reconnect = () => new Error('Связь с расширением потеряна. Перезагрузите страницу лабиринта. Если ошибка повторяется, проверьте, что расширение включено.');
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id || typeof runtime.sendMessage !== 'function') throw reconnect();
    try { return await runtime.sendMessage(message); }
    catch(error) {
      if (!globalThis.chrome?.runtime?.id || /extension context invalidated|receiving end does not exist|could not establish connection/i.test(String(error?.message))) throw reconnect();
      throw error;
    }
  }
  async function loadCloud(nearbyOnly, target = current) {
    if (!enabled || cloudLoading) return;
    if (!username) { $('cloudStatus').textContent='Не найден ваш профиль. Войдите на сайт и обновите страницу.'; return; }
    if(nearbyOnly && !point(target)){$('cloudStatus').textContent='Ожидаю вашу позицию в лабиринте.';return;}
    const nearby=nearbyOnly?{...target}:undefined;
    lastCloudArea = nearby || null;
    // Center on intent, not on completion: a late response must not undo later navigation.
    if(nearby){center={...nearby};viewPositioned=true;draw();}
    cloudLoading=true; refresh.disabled=true; $('cloud').disabled=true; $('nearby').disabled=true; $('coordinateLoad').disabled=true;
    $('cloudStatus').textContent=nearby?'Загружаю компактную карту для области ±100…':'Загружаю общую карту…';
    const job=++cloudJob, incoming={}; let cursor=null, accSent=false;
    try {
      for(let page=0;page<100;page++) {
        if(job!==cloudJob || !enabled)return;
        let result=await sendCloudRequest({type:'animesss-shared-map-page',username,cursor,nearby});
        if(job!==cloudJob || !enabled)return;
        if(result?.needsAcc && !accSent){
          $('cloudStatus').textContent='Сервер запросил подтверждение ACC: читаю только суммы и остатки…';
          const response=await fetch('/acchistory/',{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
          if(!response.ok)throw new Error(`История ACC: HTTP ${response.status}`);
          const accRows=parseAccRows(new DOMParser().parseFromString(await response.text(),'text/html'));
          if(!accRows.length)throw new Error('Не удалось прочитать суммы ACC. Войдите на сайт и проверьте историю ACC.');
          if(job!==cloudJob || !enabled)return;
          accSent=true;
          result=await sendCloudRequest({type:'animesss-shared-map-page',username,cursor,accRows,nearby});
          if(job!==cloudJob || !enabled)return;
        }
        if(!result?.ok)throw new Error(result?.error || 'Фоновое подключение недоступно. Обновите расширение и страницу.');
        if(!Array.isArray(result.rooms) || result.rooms.length>(nearby?40401:200000))throw new Error('Неизвестный формат карты');
        const pageRooms = [];
        for(let offset=0;offset<result.rooms.length;offset+=10000) {
          const normalized=normalize({current:{x:0,y:0},steps:result.rooms.slice(offset,offset+10000)});
          if(!normalized)throw new Error('Неизвестный формат карты');
          for(const room of normalized.steps) { incoming[key(room)]=room; pageRooms.push(room); }
        }
        cloudRooms={...cloudRooms,...incoming}; draw();
        for (const room of pageRooms) pendingCacheRooms[key(room)] = room;
        const pending = {...pendingCacheRooms};
        try {
          const cached = await cacheAccess(Object.values(pending), lastCloudArea);
          for (const [id, room] of Object.entries(pending)) {
            if (pendingCacheRooms[id] === room) delete pendingCacheRooms[id];
          }
          if(job!==cloudJob || !enabled)return;
          cacheUpdatedAt = cached.updatedAt;
          cloudRooms = {...unpackCache(cached),...pendingCacheRooms};
          showCacheStatus(); draw();
        } catch(error) { if(job===cloudJob)showCacheStatus(error); }
        if(job!==cloudJob || !enabled)return;
        $('cloudStatus').textContent=`Загружено ${Object.keys(incoming).length} общих комнат…`;
        if(!result.next) {
          $('cloudStatus').textContent=`${nearby?`Область ±100 от (${nearby.x}, ${nearby.y})`:'Общая карта'}: получено ${Object.keys(incoming).length} комнат. Обновлена ${new Date().toLocaleTimeString()}.`;
          return;
        }
        if(cursor && key(cursor)===key(result.next))throw new Error('Сервер повторил страницу карты');
        cursor=result.next;
      }
      throw new Error('Карта превысила лимит 200 000 комнат');
    }catch(e){if(job===cloudJob)$('cloudStatus').textContent=`${nearby?'Быстрая карта недоступна':'Загрузка прервана'}: ${e.message}. Уже показанные комнаты оставлены на карте.`;}
    finally{if(job===cloudJob){cloudLoading=false;refresh.disabled=false;$('cloud').disabled=false;$('nearby').disabled=false;$('coordinateLoad').disabled=false;}}
  }
  refresh.onclick = () => loadCloud(Boolean(lastCloudArea), lastCloudArea);
  $('cloud').onclick=()=>loadCloud(false);
  $('nearby').onclick=()=>loadCloud(true);
  function enteredPoint() {
    const x=$('coordinateX').value.trim(), y=$('coordinateY').value.trim();
    const target=/^[+-]?\d+$/.test(x) && /^[+-]?\d+$/.test(y) ? point({x:Number(x),y:Number(y)}) : null;
    $('coordinateStatus').textContent=target?'': 'Введите целые X и Y от −1000000 до 1000000.';
    return target;
  }
  $('coordinates').onsubmit=e=>{
    e.preventDefault();
    const target=enteredPoint();if(!target)return;
    center=target;viewPositioned=true;draw();
    $('coordinateStatus').textContent=`Обзор: ${target.x}, ${target.y}. Если область пуста, загрузите ±100 от точки.`;
  };
  $('coordinateLoad').onclick=()=>{const target=enteredPoint();if(target)loadCloud(true,target);};
  chrome.storage.onChanged?.addListener((changes,area) => {
    if (area === 'local' && changes[enabledKey] && loaded) applyEnabled(changes[enabledKey].newValue !== false);
  });
  function fail(error) {
    $('status').textContent = 'Не удалось сохранить карту. Обновите страницу и проверьте расширение.';
    console.warn('[Animesss map]', error?.message || error);
    if (!globalThis.chrome?.runtime?.id) { closed = true; controlBridge(); resizeObserver.disconnect(); window.removeEventListener('message', receive); }
  }
  function persist() {
    clearTimeout(writeTimer);
    if (!storageKey || closed) return;
    writeTimer = setTimeout(async () => {
      try { await chrome.storage.local.set({[storageKey]:{rooms}}); } catch (e) { fail(e); }
    }, 500);
  }
  function draw() {
    if (!enabled || !dialog.open) return;
    const w = $('view').clientWidth, h = $('view').clientHeight;
    const fragment = document.createDocumentFragment();
    const bins=new Set();
    for (const room of Object.values(viewRooms())) {
      const x = w/2+(room.x-center.x)*scale-scale/2, y = h/2+(room.y-center.y)*scale-scale/2;
      if (x < -scale || x > w || y < -scale || y > h) continue;
      if (scale<14) {
        const bin=`${Math.floor(x/18)},${Math.floor(y/18)}`;
        if(bins.has(bin) && (!current || key(current)!==key(room)))continue;
        bins.add(bin);
      }
      const cell = document.createElement('button');
      cell.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(1,scale-4)}px;height:${Math.max(1,scale-4)}px`;
      cell.textContent = `${room.note ? '★' : ''}${scale >= 24 ? (icons[room.event] || '◇') : '·'}`;
      cell.style.fontSize = `${Math.max(10,Math.min(26,scale/2))}px`;
      cell.title = `${room.x}, ${room.y}: ${label(room.event)}${room.note ? ' — '+room.note : ''}`;
      cell.setAttribute('aria-label', cell.title);
      if (current && key(room) === key(current)) cell.classList.add('here');
      if (selected === key(room)) cell.classList.add('selected');
      cell.addEventListener('click', () => {
        if (moved) return;
        selected = key(room); $('details').textContent = `${room.x}, ${room.y} — ${label(room.event)}`;
        $('note').disabled = false; $('save').disabled = false; $('note').value = room.note || ''; draw();
      });
      fragment.append(cell);
    }
    $('grid').replaceChildren(fragment);
  }
  function receive(event) {
    if (closed || !loaded || event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'animesss-local-map-ready-v1') { controlBridge(); return; }
    if (!enabled || event.data?.type !== 'animesss-local-map-v1') return;
    const data = normalize(event.data.map); if (!data) return;
    const next = JSON.stringify(data); if (next === signature) return;
    signature = next;
    const was = current;
    current = data.current; rooms = merge(rooms, data.steps);
    if (!rooms[key(current)]) rooms = merge(rooms,[{...current,event:'unknown'}]);
    if (!was && !viewPositioned) center = {...current};
    $('status').textContent = `${Object.keys(rooms).length} комнат сохранено • Позиция: ${current.x}, ${current.y} • Только этот браузер`;
    persist(); draw();
  }
  window.addEventListener('message', receive);
  $('launch').onclick = () => { dialog.showModal(); draw(); };
  $('close').onclick = () => dialog.close();
  // Do not let typing notes or moving the view reach game keyboard handlers.
  dialog.addEventListener('keydown', e => e.stopPropagation());
  $('here').onclick = () => { if(current) center = {...current}; draw(); };
  $('plus').onclick = () => {scale = Math.min(110,scale*1.25);draw();};
  $('minus').onclick = () => {scale = Math.max(8,scale/1.25);draw();};
  $('all').onclick = () => {
    const list = Object.values(viewRooms()); if (!list.length) return;
    const xs = list.map(r=>r.x), ys = list.map(r=>r.y);
    const minX = xs.reduce((a,b)=>Math.min(a,b)), maxX = xs.reduce((a,b)=>Math.max(a,b)), minY = ys.reduce((a,b)=>Math.min(a,b)), maxY = ys.reduce((a,b)=>Math.max(a,b));
    center = {x:(minX+maxX)/2,y:(minY+maxY)/2};
    scale = Math.max(2,Math.min(70,$('view').clientWidth/(maxX-minX+3),$('view').clientHeight/(maxY-minY+3))); draw();
  };
  $('save').onclick = () => {
    if (!rooms[selected] && cloudRooms[selected]) rooms[selected]={...cloudRooms[selected]};
    if (!rooms[selected]) return;
    rooms[selected].note = $('note').value.trim(); persist(); draw();
  };
  $('view').addEventListener('wheel', e => {e.preventDefault();scale=Math.max(8,Math.min(110,scale*(e.deltaY<0?1.15:1/1.15)));draw();},{passive:false});
  $('view').addEventListener('pointerdown', e => {dragging={x:e.clientX,y:e.clientY,center:{...center}};moved=false;});
  $('view').addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx=e.clientX-dragging.x,dy=e.clientY-dragging.y;
    if(Math.abs(dx)+Math.abs(dy)<5 && !moved)return;
    moved=true;center={x:dragging.center.x-dx/scale,y:dragging.center.y-dy/scale};draw();
  });
  window.addEventListener('pointerup',()=>{dragging=null;});
  $('view').addEventListener('keydown', e => {
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if(delta){e.preventDefault();center.x+=delta[0];center.y+=delta[1];draw();}
  });
  (async () => {
    // The first profile link belongs to the header's collection, before room owners.
    const profile = document.querySelector('header a[href*="/user/"]') ||
      Array.from(document.querySelectorAll('a[href*="/user/"]')).find(a=>a.textContent.includes('Коллекция') || a.title?.includes('Коллекция'));
    const path = profile && new URL(profile.href,location.href).pathname;
    if (path) {try{username=decodeURIComponent(path.split('/')[2] || '');}catch{username='';}}
    if (path) storageKey = 'animesss.localLabyrinth.v1:' + path;
    try {
      if(storageKey){
        const saved = (await chrome.storage.local.get(storageKey))[storageKey];
        for(const room of Object.values(saved?.rooms || {}).slice(-20000)){
          const data=normalize({current:room,steps:[room]});
          if(data) rooms[key(room)]={...data.steps[0],note:typeof room.note==='string'?room.note.slice(0,160):''};
        }
      } else $('hint').textContent += ' Профиль не найден: сохранение между перезагрузками отключено.';
      if (storageKey) {
        try {
          const cached = await cacheAccess();
          cloudRooms = unpackCache(cached);
          cacheUpdatedAt = Number.isFinite(cached?.updatedAt) && cached.updatedAt > 0 ? cached.updatedAt : 0;
          lastCloudArea = point(cached?.area);
          showCacheStatus();
        } catch(error) { showCacheStatus(error); }
      }
      const preference = await chrome.storage.local.get(enabledKey);
      loaded = true;
      applyEnabled(preference[enabledKey] !== false);
      $('toggle').disabled = false;
    } catch(e){fail(e); loaded=true; $('toggle').disabled=false; $('toggle').textContent='Лабиринт: включить';}
  })();
})();
