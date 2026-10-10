(function () {
  'use strict';
  function classify(card) {
    if (card.rank !== 'a') return 'other';
    if (!/^\d+$/.test(card.id || '')) return 'unknown';
    if (card.icons.includes('fa-arrow-right-arrow-left') || card.icons.includes('fa-trophy-alt')) return 'unavailable';
    if (card.icons.includes('fa-lock')) return 'locked';
    return card.icons.includes('fa-unlock') ? 'unlock' : 'unknown';
  }
  function createLedger(storage,key) {
    function read() {
      const data=JSON.parse(storage.getItem(key) || '{}');
      if(!data || typeof data!=='object' || Array.isArray(data) || Object.entries(data).some(([id,state])=>!/^\d+$/.test(id) || !['pending','confirmed','releasing'].includes(state)))throw new Error('Журнал ID повреждён; автоматические изменения запрещены');
      return data;
    }
    return {
      confirmed:()=>Object.entries(read()).filter(([,s])=>s==='confirmed').map(([id])=>id),
      set(ids,state){
        const data=read();
        for(const id of ids){if(!/^\d+$/.test(id))throw new Error('Неверный ID');if(state===null)delete data[id];else data[id]=state;}
        storage.setItem(key,JSON.stringify(data));
      }
    };
  }
  async function runUnlock({readPage,unlockPage,sleep,stopped,log,ledger}) {
    const count={checked:0,locked:0,unlocked:0,already:0,skipped:0,errors:0,pages:0,status:'running'};
    const report=text=>log(text,{...count});
    try {
      const owned=new Set(await ledger.confirmed()),seen=new Set();
      if(!owned.size){count.status='done';report('В журнале нет подтверждённых блокировок этой закладки. Старые и ручные замки не тронуты.');return count;}
      for(let page=1;page<=1000;page++) {
        if(stopped()){count.status='stopped';break;}
        const before=await readPage(page),ids=[];
        for(const card of before.cards) {
          if(!owned.has(card.id) || seen.has(card.id))continue;
          seen.add(card.id);count.checked++;
          const state=classify(card);
          if(state==='locked')ids.push(card.id);
          else if(state==='unlock'){await ledger.set([card.id],null);count.already++;}
          else if(state==='unknown')throw new Error('Неизвестное состояние своей блокировки '+card.id);
          else count.skipped++;
        }
        if(ids.length) {
          await sleep(1500);if(stopped()){count.status='stopped';break;}
          // Quarantine before writing: uncertain results must never be retried automatically.
          await ledger.set(ids,'releasing');
          if(stopped()){count.status='stopped';break;}
          report('Страница '+page+': разблокировка '+ids.length+' карт из журнала');
          const answer=await unlockPage(ids);
          if(!answer || answer.error || answer.hacker || answer.success===false)throw new Error(String(answer?.error || answer?.hacker || 'Отказ сервера'));
          await sleep(1500);
          const after=await readPage(page);
          const open=new Set(after.cards.filter(c=>classify(c)==='unlock').map(c=>c.id));
          const done=ids.filter(id=>open.has(id));count.unlocked+=done.length;
          await ledger.set(done,null);
          report('Страница '+page+': разблокировано '+done.length+'; всего '+count.unlocked);
          if(done.length!==ids.length)throw new Error('Не все разблокировки подтверждены. Спорные ID исключены из автоматических повторов');
        }
        count.pages++;
        if(!before.next){count.status='done';count.skipped+=owned.size-seen.size;break;}
        if(page===1000)throw new Error('Превышен предел 1000 страниц');
        await sleep(1500);
      }
    }catch(e){count.errors++;count.status='error';report('ОШИБКА разблокировки: '+e.message+'. Автоповтора нет.');}
    report((count.status==='done'?'Готово':count.status==='stopped'?'Остановлено':'Прервано')+': разблокировано '+count.unlocked+', уже открыто '+count.already+', пропущено '+count.skipped+', ошибок '+count.errors);
    return count;
  }
  async function run({readPage, lockPage, sleep, stopped, log, mode='all',beforeLock=async()=>{},rememberLocked=async()=>{}}) {
    const count={checked:0,locked:0,already:0,skipped:0,errors:0,pages:0,status:'running'};
    const seen=new Set();
    const report=text=>log(text,{...count});
    try {
      for(let batch=1;batch<=1000;batch++) {
        const page=mode==='unlocked'?1:batch;
        if(stopped()){count.status='stopped';break;}
        const before=await readPage(page);
        if(mode==='unlocked' && before.empty===true && !before.cards.length && !before.next){count.status='done';break;}
        if(!before.cards.some(card=>card.rank==='a'))throw new Error('На странице '+page+' нет карт A. Проверьте вход и фильтр');
        const ids=[];let already=0, fresh=0;
        for(const card of before.cards) {
          if(card.rank!=='a')continue;
          const state=classify(card);
          if(mode==='unlocked' && state==='locked')throw new Error('Фильтр незаблокированных не применён');
          if(state==='unknown')throw new Error('Неизвестное состояние замка: '+(card.id || '?'));
          if(seen.has(card.id))continue;
          seen.add(card.id);fresh++;count.checked++;
          if(state==='locked'){already++;count.already++;}
          else if(state==='unavailable')count.skipped++;
          else ids.push(card.id);
        }
        if(!fresh && before.next)throw new Error('Повтор или пустая страница; остановка для проверки');
        report('Страница '+page+(mode==='unlocked'?' (порция '+batch+')':'')+': к блокировке '+ids.length+', уже закрыто '+already);
        if(mode==='unlocked' && !ids.length)throw new Error('На первой странице нет доступных для блокировки карт. Переход вперёд отключён');
        if(ids.length) {
          await sleep(1500);
          if(stopped()){count.status='stopped';break;}
          await beforeLock(ids);
          if(stopped()){count.status='stopped';break;}
          report('Отправка массовой блокировки: '+ids.length+' карт');
          const answer=await lockPage(ids);
          if(!answer || answer.error || answer.hacker || answer.success===false)throw new Error(String(answer?.error || answer?.hacker || 'Отказ сервера'));
          await sleep(1500);
          // Finish read-only verification even when Stop was pressed during POST.
          const after=await readPage(page);
          if(mode==='unlocked' && !after.cards.length && after.empty!==true)throw new Error('Проверка вернула неподтверждённую пустую страницу');
          if(mode==='unlocked' && after.cards.some(c=>!['unlock','unavailable'].includes(classify(c))))throw new Error('Некорректные карты или фильтр в ответе проверки; счётчик не увеличен');
          const confirmed=new Set(after.cards.filter(c=>classify(c)==='locked').map(c=>c.id));
          const remaining=new Set(after.cards.map(c=>c.id));
          const confirmedIds=ids.filter(id=>mode==='unlocked'?!remaining.has(id):confirmed.has(id));
          const added=confirmedIds.length;
          count.locked+=added;
          await rememberLocked(confirmedIds);
          report('Страница '+page+': новых блокировок '+added+', уже было '+already+'; всего за запуск '+count.locked);
          if(mode==='unlocked')report('Проверка: после успешного ответа сайта '+added+' карт исчезли из незаблокированных.');
          if(added!==ids.length)throw new Error('Не подтверждены '+(ids.length-added)+' блокировок. Повтор не отправлен; проверьте страницу '+page);
        }
        count.pages++;
        if(mode!=='unlocked' && !before.next){count.status='done';break;}
        if(batch===1000)throw new Error('Превышен предел 1000 порций');
        await sleep(1500);
      }
    }catch(error){count.errors++;count.status='error';report('ОШИБКА: '+error.message+'. Автоповтора нет.');}
    report((count.status==='done'?'Готово':count.status==='stopped'?'Остановлено':'Прервано')+
      ': заблокировано '+count.locked+', уже было '+count.already+', пропущено '+count.skipped+', ошибок '+count.errors);
    return count;
  }
  if(typeof module!=='undefined' && module.exports){module.exports={classify,run,runUnlock,createLedger};return;}
  // Content-script world: expose the tested core without opening the bookmark UI.
  if(globalThis.chrome?.runtime?.id){globalThis.AnimesssCardLockCore={classify,run,runUnlock,createLedger};return;}
  if(location.protocol!=='https:' || !['animesss.com','animesss.tv'].includes(location.hostname))return alert('Откройте свою коллекцию на Animesss.');
  if(document.getElementById('as-mobile-lock'))return alert('Панель блокировки уже открыта.');
  const name=typeof visitor_name==='string'?visitor_name:'';
  const hash=typeof dle_login_hash==='string'?dle_login_hash:'';
  if(!name || !hash || location.pathname!=='/user/cards/' || new URL(location.href).searchParams.get('name')!==name) {
    return alert('Откройте свою коллекцию: /user/cards/?name=ВАШ_НИК. Затем запустите закладку ещё раз.');
  }
  let stop=false, running=false;
  const storageKey='animesss.mobileLock.log:'+name;
  const ledger=createLedger(localStorage,'animesss.mobileLock.owned.v1:'+name);
  const host=document.createElement('div');host.id='as-mobile-lock';
  host.style.cssText='position:fixed;inset:10px;z-index:2147483647;background:#202638;color:white;padding:16px;overflow:auto;font:16px system-ui;border:2px solid #8da4cc;border-radius:12px;box-sizing:border-box';
  const title=document.createElement('h3');title.textContent='Блокировка всех ваших карт A';host.append(title);
  const note=document.createElement('p');note.textContent='Без A+. «Вся коллекция» — страницы 1, 2, 3… «Незаблокированные» — всегда первая страница, пока выборка не опустеет. Не меняйте коллекцию параллельно. Держите вкладку открытой.';host.append(note);
  const ownershipNote=document.createElement('p');ownershipNote.textContent='Разблокировка — только ID, записанные этой версией закладки в этом браузере и на этом домене. Старые блокировки не учтены. Не переустанавливайте замки вручную на учтённых картах: такие изменения не отслеживаются.';host.append(ownershipNote);
  const controls=document.createElement('div');host.append(controls);
  function button(text,fn){const b=document.createElement('button');b.textContent=text;b.style.cssText='font:inherit;padding:12px;margin:4px';b.onclick=fn;controls.append(b);return b;}
  const status=document.createElement('p');host.append(status);
  const area=document.createElement('textarea');area.readOnly=true;area.setAttribute('aria-label','Лог блокировки');area.style.cssText='width:100%;height:45vh;box-sizing:border-box;font:13px monospace';host.append(area);
  let lines=[];
  try {const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(saved))lines=saved.filter(x=>typeof x==='string').slice(-1000);}catch{}
  area.value=lines.join('\n');
  function log(text,count){
    lines.push(new Date().toLocaleString()+' — '+text);lines=lines.slice(-1000);
    area.value=lines.join('\n');area.scrollTop=area.scrollHeight;
    if(count)status.textContent=(count.unlocked===undefined?'Заблокировано: '+count.locked:'Разблокировано: '+count.unlocked)+' | Уже было: '+count.already+' | Проверено: '+count.checked+' | Ошибок: '+count.errors;
    try{localStorage.setItem(storageKey,JSON.stringify(lines));}catch{status.textContent+=' | Лог не сохранён: скопируйте его';}
  }
  async function request(url,options={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
      if(!response.ok)throw new Error('HTTP '+response.status);
      return options.method==='POST'?await response.json():new DOMParser().parseFromString(await response.text(),'text/html');
    }finally{clearTimeout(timer);}
  }
  async function readPage(page,mode) {
    const url=new URL('/user/cards/',location.origin);url.search=new URLSearchParams({name,rank:'a',page:String(page)});
    if(mode==='unlocked')url.searchParams.set('locked','0');
    const doc=await request(url.href);
    const owner=doc.querySelector('.tabs--center[data-kind="owned"]');
    if(owner?.getAttribute('data-user')!==name)throw new Error('Не подтверждена страница вашей коллекции');
    const items=[...doc.querySelectorAll('.anime-cards__item')];
    const empty=mode==='unlocked' && /\(\s*0\s*шт\.?\s*\)/.test(doc.querySelector('.ncard__main-title')?.textContent || '');
    if(!items.length && empty)return {cards:[],next:false,empty:true};
    if(!items.length)throw new Error('Страница '+page+': карты не найдены — проверьте вход и фильтр');
    const cards=items.map(el=>({rank:el.getAttribute('data-rank'),id:el.getAttribute('data-owner-id'),
      icons:[...el.querySelectorAll('.lock-card-btn i')].flatMap(i=>[...i.classList])}));
    const next=[...doc.querySelectorAll('a[href]')].some(a=>{
      try{const u=new URL(a.getAttribute('href'),location.origin);return u.origin===location.origin && u.pathname==='/user/cards/' && u.searchParams.get('name')===name && Number(u.searchParams.get('page'))===page+1;}catch{return false;}
    });
    return {cards,next};
  }
  async function startRun(mode) {
    const unlocking=mode==='undo';
    if(running || !confirm(unlocking?'Разблокировать только карты A из журнала этой закладки? Ручные и старые блокировки без записи не затрагиваются.':'Заблокировать ваши карты A на ВСЕХ страницах? A+ не затрагиваются.'))return;
    running=true;stop=false;start.disabled=true;first.disabled=true;undo.disabled=true;close.disabled=true;stopButton.disabled=false;
    if(unlocking) {
      log('Начало разблокировки только по журналу ID закладки.');
      try {await runUnlock({ledger,readPage:page=>readPage(page,'all'),unlockPage:ids=>{
        const body=new URLSearchParams({user_hash:hash});ids.forEach(id=>body.append('ids[]',id));
        return request('/ajax/page_unlock_cards/',{method:'POST',body});
      },sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),stopped:()=>stop,log});}
      finally{running=false;start.disabled=false;first.disabled=false;undo.disabled=false;close.disabled=false;stopButton.disabled=true;}
      return;
    }
    log('Начало нового запуска для '+name+'; ранг A; режим: '+(mode==='unlocked'?'незаблокированные, всегда первая страница':'вся коллекция, последовательные страницы'));
    try {await run({mode,beforeLock:ids=>ledger.set(ids,'pending'),rememberLocked:ids=>ledger.set(ids,'confirmed'),readPage:page=>readPage(page,mode),lockPage:ids=>{
      const body=new URLSearchParams({user_hash:hash});ids.forEach(id=>body.append('ids[]',id));
      return request('/ajax/page_lock_cards/',{method:'POST',body});
    },sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),stopped:()=>stop,log});}
    finally{running=false;start.disabled=false;first.disabled=false;undo.disabled=false;close.disabled=false;stopButton.disabled=true;}
  }
  const start=button('Вся коллекция — по страницам',()=>startRun('all'));
  const first=button('Незаблокированные — первая страница',()=>startRun('unlocked'));
  const undo=button('Разблокировать только сделанное закладкой',()=>startRun('undo'));
  const stopButton=button('Стоп',()=>{stop=true;log('Запрошена остановка; ожидаю завершения текущей операции.');});stopButton.disabled=true;
  button('Скопировать лог',async()=>{try{await navigator.clipboard.writeText(area.value);alert('Лог скопирован');}catch{area.focus();area.select();alert('Выделен лог — выберите «Копировать».');}});
  const close=button('Закрыть',()=>{if(!running)host.remove();});
  document.body.append(host);
})();
