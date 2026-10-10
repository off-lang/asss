const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let chromium;try{({chromium}=require('playwright'));}catch{}
test('extension buttons lock shrinking first page and undo only recorded A locks after reload',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page=await browser.newPage({viewport:{width:1000,height:480}}), locked=new Set(['2']),posts=[],reads=[];
    await page.route('**/*',async route=>{
      const r=route.request(),u=new URL(r.url());
      if(u.pathname==='/user/cards/') {
        const filtered=u.searchParams.get('locked')==='0';
        const ids=filtered?['1','4'].filter(id=>!locked.has(id)).slice(0,1):['1','2','3','4'];
        if(filtered)reads.push(u.searchParams.get('page'));
        return route.fulfill({contentType:'text/html',body:`<script>var visitor_name='Tester';var dle_login_hash='testhash123';</script><div class="tabs--center" data-kind="owned" data-user="Tester"></div><h1 class="ncard__main-title">Карточки (${ids.length} шт.)</h1>`+ids.map(id=>`<div class="anime-cards__item" data-owner-id="${id}" data-rank="${id==='3'?'a_plus':'a'}"><button class="lock-card-btn"><i class="${locked.has(id)?'fa-lock':'fa-unlock'}"></i></button></div>`).join('')});
      }
      if(['/ajax/page_lock_cards/','/ajax/page_unlock_cards/'].includes(u.pathname)){
        const ids=new URLSearchParams(r.postData()).getAll('ids[]');
        posts.push({path:u.pathname,ids});
        ids.forEach(id=>u.pathname.includes('unlock')?locked.delete(id):locked.add(id));
        return route.fulfill({contentType:'application/json',body:'{"status":"ok"}'});
      }
      throw new Error('Unexpected request '+r.url());
    });
    async function mount(saved={}) {
      await page.addStyleTag({path:require.resolve('../content.css')});
      await page.evaluate(values=>{
        window.values=values;window.chrome={runtime:{id:'fixture'},storage:{local:{get:async k=>({[k]:window.values[k]}),set:async obj=>Object.assign(window.values,obj)}}};
        const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===1500&&!window.slowLock?5:ms,...args);
      },saved);
      await page.addScriptTag({path:require.resolve('../card-helper.js')});
      await page.addScriptTag({path:require.resolve('../mobile-lock.js')});
      await page.evaluate(source=>{
        const api=new Function('const window=undefined; const module={exports:{}};'+source+';return module.exports;')();
        window.cardUi=api.mountUi(document);window.getLockIdentity=()=>({name:api.extractVisitorName(document),hash:AnimesssCardHelper.extractUserHash(document)});
      },fs.readFileSync(require.resolve('../content.js'),'utf8'));
      assert.equal(await page.getByRole('button',{name:'Блокировать все A',exact:true,includeHidden:true}).count(),1);
      await page.addScriptTag({path:require.resolve('../card-lock.js')});
      await page.evaluate(()=>AnimesssCardLock.mount({ui:cardUi,getIdentity:getLockIdentity}));
      await page.getByRole('button',{name:'Открыть инструменты карточек',exact:true}).click();
      const panel=await page.locator('#animesss-card-helper-actions').boundingBox();
      assert.ok(panel.y+panel.height<=480,'action panel must fit a short viewport');
    }
    await page.goto('https://animesss.com/user/cards/?name=Tester');await mount();
    page.on('dialog',d=>d.accept());
    await page.getByRole('button',{name:'Блокировать все A',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#as-card-lock-log')?.value.includes('Готово: заблокировано 2'));
    assert.deepEqual(posts.map(p=>p.ids),[['1'],['4']]);assert.ok(reads.every(p=>p==='1'));
    const saved=await page.evaluate(()=>window.values);
    await page.reload();await mount(saved);
    await page.getByRole('button',{name:'Отменить блок A',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#as-card-lock-log')?.value.includes('Готово: разблокировано 2'));
    assert.deepEqual(posts.at(-1),{path:'/ajax/page_unlock_cards/',ids:['1','4']});
    assert.deepEqual([...locked],['2']);
    // An empty undo journal must not send any new mutation.
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    await page.getByRole('button',{name:'Отменить блок A',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#as-card-lock-log')?.value.includes('В журнале нет подтверждённых'));
    assert.equal(posts.length,3);
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    // Stop during the pre-mutation delay must prevent the next POST.
    await page.evaluate(()=>window.slowLock=true);
    await page.getByRole('button',{name:'Блокировать все A',exact:true}).click();
    await page.getByRole('button',{name:'Стоп',exact:true}).click();
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    assert.equal(posts.length,3);
    await page.evaluate(()=>{window.slowLock=false;navigator.locks.request('animesss-card-lock:Tester',()=>new Promise(resolve=>window.releaseHeld=resolve));});
    await page.waitForFunction(()=>!!window.releaseHeld);
    await page.getByRole('button',{name:'Блокировать все A',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#as-card-lock-log').value.includes('другой вкладке'));
    assert.equal(posts.length,3);
    await page.evaluate(()=>window.releaseHeld());
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    // Failure to persist intent must prevent any change on the website.
    await page.evaluate(()=>{const original=chrome.storage.local.set;chrome.storage.local.set=async obj=>{
      if(Object.keys(obj).some(k=>k.includes('.owned.')))throw new Error('fixture storage failure');return original(obj);
    };});
    await page.getByRole('button',{name:'Блокировать все A',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#as-card-lock-log').value.includes('fixture storage failure'));
    assert.equal(posts.length,3);
  } finally {await browser.close();}
});
