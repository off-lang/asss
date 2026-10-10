// Extension adapter for the shared, tested bookmark locking core.
(() => {
  'use strict';
  function mount({ui,getIdentity}) {
    const core=globalThis.AnimesssCardLockCore;
    let running=false,stop=false,lines=[],logTail=Promise.resolve();
    const dialog=document.createElement('dialog');
    dialog.style.cssText='width:min(760px,94vw);max-height:90vh;overflow:auto;background:#202638;color:#fff;border:1px solid #8999ba;border-radius:12px;padding:18px;font:15px system-ui;z-index:2147483647';
    const title=document.createElement('h3');title.textContent='Блокировка карт A';
    const note=document.createElement('p');note.textContent='Только A, без A+. Держите вкладку открытой. Не меняйте замки параллельно: ручное снятие и повторная установка замка на учтённой карте не отслеживаются. Отмена снимает только записанные этим расширением блокировки, не блокировки закладки.';
    const status=document.createElement('p');status.setAttribute('role','status');
    const area=document.createElement('textarea');area.id='as-card-lock-log';area.readOnly=true;area.setAttribute('aria-label','Журнал блокировок A');area.style.cssText='width:100%;height:35vh;box-sizing:border-box;background:#151b2a;color:#fff;font:13px monospace';
    const controls=document.createElement('div');
    function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='padding:10px;margin:6px;font:inherit';b.onclick=fn;controls.append(b);return b;}
    const stopButton=button('Стоп',()=>{stop=true;status.textContent='Останавливаем после проверки текущего запроса…';});stopButton.disabled=true;
    button('Скопировать лог',async()=>{try{await navigator.clipboard.writeText(area.value);}catch{area.focus();area.select();status.textContent='Выделен лог — скопируйте вручную.';}});
    const closeButton=button('Закрыть',()=>dialog.close());
    dialog.append(title,note,status,area,controls);document.body.append(dialog);
    dialog.addEventListener('cancel',e=>{if(running)e.preventDefault();});
    function show(){if(!dialog.open)dialog.showModal();}
    function identity(){
      const value=getIdentity(),url=new URL(location.href);
      if(!value?.name || !value.hash || url.pathname!=='/user/cards/' || url.searchParams.get('name')!==value.name ||
        document.querySelector('.tabs--center[data-kind="owned"]')?.getAttribute('data-user')!==value.name)throw new Error('Откройте свою коллекцию /user/cards/?name=ВАШ_НИК и повторите.');
      return value;
    }
    function keys(name){const suffix=location.origin+':'+name;return {ledger:'animesss.extensionLock.owned.v1:'+suffix,log:'animesss.extensionLock.log:'+suffix};}
    async function loadLog(key){await logTail;const saved=(await chrome.storage.local.get(key))[key];lines=Array.isArray(saved)?saved.filter(x=>typeof x==='string').slice(-500):[];area.value=lines.join('\n');}
    async function request(url,options={}){
      if(!chrome.runtime?.id)throw new Error('Расширение обновлено — перезагрузите страницу.');
      const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('HTTP '+response.status+'; повтор не отправлен');
      return options.method==='POST'?response.json():new DOMParser().parseFromString(await response.text(),'text/html');
    }
    async function readPage(name,page,unlocked){
      const url=new URL('/user/cards/',location.origin);url.search=new URLSearchParams({name,rank:'a',page:String(page)});
      if(unlocked)url.searchParams.set('locked','0');
      const doc=await request(url);
      if(doc.querySelector('.tabs--center[data-kind="owned"]')?.getAttribute('data-user')!==name)throw new Error('Не подтверждена страница вашей коллекции');
      const items=[...doc.querySelectorAll('.anime-cards__item')];
      const empty=/\(\s*0\s*шт\.?\s*\)/.test(doc.querySelector('.ncard__main-title')?.textContent || '');
      if(!items.length && !empty)throw new Error('Карты не найдены: не подтверждена пустая коллекция');
      const cards=items.map(el=>({rank:el.getAttribute('data-rank'),id:el.getAttribute('data-owner-id'),icons:[...el.querySelectorAll('.lock-card-btn i')].flatMap(i=>[...i.classList])}));
      const next=[...doc.querySelectorAll('a[href]')].some(a=>{try{const u=new URL(a.getAttribute('href'),location.origin);return u.origin===location.origin && u.pathname==='/user/cards/' && u.searchParams.get('name')===name && Number(u.searchParams.get('page'))===page+1;}catch{return false;}});
      return {cards,next,empty};
    }
    async function start(undo){
      if(running)return;
      let account;
      try {account=identity();}catch(e){ui.notify('error',e.message);return;}
      if(!confirm(undo?'Снять только блокировки A, записанные расширением? Ручные и старые замки без записи не затрагиваются.':'Заблокировать все доступные карты A в вашей коллекции? Карты A+ не затрагиваются.'))return;
      running=true;stop=false;ui.lockButton.disabled=true;ui.unlockButton.disabled=true;ui.lockJournalButton.disabled=true;stopButton.disabled=false;closeButton.disabled=true;show();
      const key=keys(account.name);
      function log(text,count){
        lines.push(new Date().toLocaleString()+' — '+text.replace(/этой закладки/g,'этого расширения'));lines=lines.slice(-500);area.value=lines.join('\n');area.scrollTop=area.scrollHeight;
        if(count)status.textContent=`${undo?'Разблокировано: '+count.unlocked:'Заблокировано: '+count.locked} | Пропущено: ${count.skipped} | Ошибок: ${count.errors}`;
        const snapshot=[...lines];logTail=logTail.then(()=>chrome.storage.local.set({[key.log]:snapshot})).catch(()=>{status.textContent+=' | Лог не сохранён';});
      }
      try {
        if(!navigator.locks)throw new Error('Браузер не поддерживает защиту от параллельного запуска');
        await loadLog(key.log);
        await navigator.locks.request('animesss-card-lock:'+account.name,{ifAvailable:true},async lock=>{
          if(!lock)throw new Error('Блокировка уже запущена в другой вкладке');
          let raw=JSON.stringify((await chrome.storage.local.get(key.ledger))[key.ledger] || {});
          const memory=core.createLedger({getItem:()=>raw,setItem:(_,v)=>{raw=v;}},key.ledger);
          const ledger={confirmed:memory.confirmed,set:async(ids,state)=>{memory.set(ids,state);await chrome.storage.local.set({[key.ledger]:JSON.parse(raw)});}};
          async function change(ids,unlock){
            const now=identity();if(now.name!==account.name)throw new Error('Аккаунт изменился — операция остановлена');
            const body=new URLSearchParams({user_hash:now.hash});ids.forEach(id=>body.append('ids[]',id));
            return request(unlock?'/ajax/page_unlock_cards/':'/ajax/page_lock_cards/',{method:'POST',body});
          }
          const common={sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),stopped:()=>stop,log};
          log(undo?'Начало отмены блокировок A по журналу расширения':'Начало блокировки A: незаблокированные, всегда первая страница');
          if(undo)await core.runUnlock({...common,ledger,readPage:p=>readPage(account.name,p,false),unlockPage:ids=>change(ids,true)});
          else await core.run({...common,mode:'unlocked',readPage:p=>readPage(account.name,p,true),lockPage:ids=>change(ids,false),beforeLock:async ids=>{
            memory.confirmed(); // Validate the entire journal before any mutation.
            const data=JSON.parse(raw);
            if(ids.some(id=>data[id]==='pending'||data[id]==='releasing'))throw new Error('Есть неподтверждённые операции с этими картами. Автоповтор запрещён');
            await ledger.set(ids,'pending');
          },rememberLocked:ids=>ledger.set(ids,'confirmed')});
        });
      }catch(e){log('ОШИБКА: '+e.message);status.textContent=e.message;}
      finally {await logTail;running=false;ui.lockButton.disabled=false;ui.unlockButton.disabled=false;ui.lockJournalButton.disabled=false;stopButton.disabled=true;closeButton.disabled=false;}
    }
    ui.lockButton.addEventListener('click',()=>start(false));
    ui.unlockButton.addEventListener('click',()=>start(true));
    ui.lockJournalButton.addEventListener('click',async()=>{try{await loadLog(keys(identity().name).log);show();}catch(e){ui.notify('error',e.message);}});
  }
  globalThis.AnimesssCardLock={mount};
})();
