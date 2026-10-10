// Read-only map client for the protocol used by VladLIO's Labyrinth Map 10.52.
// Never forward site cookies, account tokens, balances or player routes.
(() => {
  const SCRIPT_VERSION = '10.52';
  const FAST_TYPES = ['unknown','empty','penalty','quiz','puzzle','reward','luck_altar','locked_chest','spiritual_teleport','echo_room','mini_boss','relic_room','card_trader','fate_room','mimic_chest','mimic_chest_back','hard_boss','jackpot','collection','club_war_room','resonance_room','recovery_room','personal_mine','kobold_room','reward_card','trap_back','room_gift','room_trap','shield_block','mimic_chest_reward','start','room_trap_result'];
  let typeHash = 0x811c9dc5;
  for (const c of FAST_TYPES.join('|')) typeHash = Math.imul(typeHash ^ c.charCodeAt(0), 0x01000193);
  function validCenter(p) {
    return p && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y) && Math.abs(p.x)<=1000000 && Math.abs(p.y)<=1000000;
  }
  function parseNearby(buffer, center) {
    if (center !== null && !validCenter(center)) throw new Error('Не определена позиция игрока');
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) throw new Error('Повреждён заголовок быстрой карты');
    const view = new DataView(buffer), count = view.getUint32(8,true), magic=view.getUint32(0,false);
    const tail=magic===0x4c4d4633?view.getUint32(20,true):0;
    if (![0x4c4d4632,0x4c4d4633].includes(magic) || view.getUint16(4,true)!==24 || view.getUint16(6,true)!==6 ||
      count>2000000 || tail>8000000 || buffer.byteLength!==24+count*6+tail) {
      throw new Error('Неизвестный формат быстрой карты');
    }
    if (center === null && count > 200000) throw new Error('Карта больше 200 000 комнат. Загрузите область ±100; кэш сохранён.');
    let names=FAST_TYPES, extra=null;
    if(tail) {
      try { extra=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(buffer,24+count*6,tail))); }
      catch { throw new Error('Неизвестный формат быстрой карты: повреждены дополнительные данные'); }
      if(!extra || typeof extra!=='object' || Array.isArray(extra))throw new Error('Неизвестный формат быстрой карты');
    }
    if(extra?.types!==undefined) {
      if(!Array.isArray(extra.types) || !extra.types.length || extra.types.length>256 ||
        !extra.types.every(t=>typeof t==='string' && /^[a-z0-9_]{1,40}$/.test(t)))throw new Error('Неизвестный формат быстрой карты: таблица типов');
      names=extra.types;
    } else if(view.getUint32(16,true)!==(typeHash>>>0))throw new Error('Неизвестный формат быстрой карты: таблица типов');
    const rooms=[];
    for(let i=0;i<count;i++) {
      const x=view.getInt16(24+2*i,true), y=view.getInt16(24+2*count+2*i,true);
      if(center && (Math.abs(x-center.x)>100 || Math.abs(y-center.y)>100))continue;
      const flags=view.getUint8(24+5*count+i);
      const event=flags&4?'room_gift':flags&8?'room_trap':names[view.getUint8(24+4*count+i)] || 'unknown';
      rooms.push({x,y,event});
    }
    return {rooms,next:null};
  }
  function createClient({storage, fetch, uuid, sleep}) {
    let tail = Promise.resolve();
    async function request(path, options = {}, center = null) {
      const response = await fetch('https://labyrinthmap.uk/api' + path, {
        ...options, credentials:'omit', referrerPolicy:'no-referrer', redirect:'error',
        signal:AbortSignal.timeout(15000),
      });
      const stage = path.startsWith('/device/bind') ? 'регистрация устройства' : 'загрузка карты';
      const isMap = path.startsWith('/map/fast');
      const type=response.headers?.get('content-type') || '';
      if(response.ok && isMap && /application\/(?:vnd\.labyrinth\.map\+binary|octet-stream)/i.test(type)) {
        return parseNearby(await response.arrayBuffer(),center);
      }
      let data = {}, parsed = false;
      try {
        const text = await response.text();
        if (text.length <= 8000000) {
          const value = JSON.parse(text);
          if (value && typeof value === 'object' && !Array.isArray(value)) { data=value; parsed=true; }
        }
      } catch { /* Never expose raw server text, which may contain account data. */ }
      const messages = {
        blocked:'Сервер запретил доступ к карте', forbidden:'Доступ запрещён',
        need_auth:'Требуется авторизация устройства', invalid_auth:'Авторизация устройства недействительна',
        device_limit:'Достигнут лимит устройств', bind_conflict:'Конфликт привязки устройства',
        device_revoked:'Регистрация устройства отозвана', acc_proof_locked:'Проверка ACC временно заблокирована',
        client_outdated:'Сервер требует новую версию протокола карты',
      };
      const rawCode = data.blocked ? 'blocked' : data.outdated ? 'client_outdated' : data.need_auth ? 'need_auth' :
        data.forbidden ? 'forbidden' : (data.code || data.error);
      const code = Object.hasOwn(messages,rawCode) ? rawCode :
        response.status===426 ? 'client_outdated' : response.status===410 ? 'device_revoked' :
        response.status===401 ? 'invalid_auth' : '';
      if (!response.ok || code || data.error || data.success === false || data.ok === false) {
        const description = messages[code] || (response.status===429 ? 'Слишком много запросов; повторите позже' : 'Отказ сервера');
        const error=new Error(`${stage}: ${description}${code ? ` (${code})` : ''}${response.status ? `, HTTP ${response.status}` : ''}`);
        error.needsAcc=path==='/device/bind' && response.status===403 && !rawCode;
        error.authRequired=code==='need_auth' || code==='invalid_auth';
        throw error;
      }
      if (isMap) throw new Error(`${stage}: сервер не предоставил бинарную карту`);
      if (!parsed) throw new Error(`${stage}: неизвестный ответ сервера`);
      return data;
    }
    async function page({username,cursor,accRows,nearby}) {
      if(nearby !== undefined && !validCenter(nearby))throw new Error('Не определена позиция игрока');
      if (typeof username !== 'string' || !username.trim() || username.length > 100 || /[\x00-\x1f]/.test(username)) throw new Error('Не определён профиль Animesss');
      if (cursor && (!Number.isSafeInteger(cursor.x) || !Number.isSafeInteger(cursor.y))) throw new Error('Неверный указатель страницы');
      if(accRows !== undefined && (!Array.isArray(accRows) || !accRows.length || accRows.length>100 ||
        accRows.some(r=>!Number.isSafeInteger(r?.acc_delta)||!Number.isSafeInteger(r?.acc_after)||r.acc_after<0)))throw new Error('Неверные данные ACC');
      const saved = await storage.get('animesss.localLabyrinth.enabled');
      if (saved['animesss.localLabyrinth.enabled'] === false) throw new Error('Лабиринт выключен');
      const idKey = 'animesss.sharedMap.device:' + username;
      let identity = (await storage.get(idKey))[idKey];
      if (!identity?.token) {
        identity = {token:'lmd_' + uuid(),bound:false};
        await storage.set({[idKey]:identity});
      }
      async function bind() {
        const body={username,device_token:identity.token};
        if(accRows && identity.accRequested) body.acc_rows=accRows.map(r=>({acc_delta:r.acc_delta,acc_after:r.acc_after}));
        try {await request('/device/bind', {method:'POST',headers:{'Content-Type':'application/json','X-Script-Version':SCRIPT_VERSION},
          body:JSON.stringify(body)});}
        catch(error){if(error.needsAcc){identity.accRequested=true;await storage.set({[idKey]:identity});}throw error;}
        identity.bound = true;
        identity.accRequested=false;
        await storage.set({[idKey]:identity});
      }
      if(!identity.bound)await bind();
      const headers = {'X-Player':/[^\x00-\xff]/.test(username)?encodeURIComponent(username):username,
        'X-Script-Version':SCRIPT_VERSION,Authorization:'Bearer '+identity.token};
      // The current upstream client reads the binary map directly in both modes.
      // Authentication failures get one same-device rebind; explicit blocks never do.
      try{return await request('/map/fast?v=3', {headers}, nearby || null);}
      catch(error){
        if(!error.authRequired)throw error;
        identity.bound=false;await storage.set({[idKey]:identity});
        await bind();
        return request('/map/fast?v=3', {headers}, nearby || null);
      }
    }
    return {load(args) {
      const result = tail.then(()=>page(args));
      tail = result.catch(()=>{}).then(()=>sleep(750));
      return result;
    }};
  }
  if (typeof module !== 'undefined') {module.exports={createClient,parseNearby};return;}
  const client = createClient({storage:chrome.storage.local,fetch:globalThis.fetch.bind(globalThis),
    uuid:()=>crypto.randomUUID(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.type !== 'animesss-shared-map-page')return;
    let url;try{url=new URL(sender.url);}catch{return;}
    if(!sender.tab || sender.frameId!==0 || url.protocol!=='https:' ||
      !['animesss.com','animesss.tv'].includes(url.hostname) || !/^\/labyrinth\/$/.test(url.pathname))return;
    client.load({username:message.username,cursor:message.cursor,accRows:message.accRows,nearby:message.nearby}).then(data=>reply({ok:true,...data}),
      error=>reply({ok:false,needsAcc:error.needsAcc===true,error:String(error.message || 'Ошибка общей карты')}));
    return true;
  });
})();
