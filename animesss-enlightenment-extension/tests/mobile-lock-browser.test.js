const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let chromium;try{({chromium}=require('playwright'));}catch{}
test('mobile bookmarklet UI processes all pages and persists confirmed log (offline browser)',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}}),locked=new Set(['2']),posts=[];
    const filteredReads=[],unlockPosts=[];
    const html=(n,filtered=false)=>{
      const ids=filtered?['1','4'].filter(id=>!locked.has(id)).slice(0,1):(n===1?['1','2','3']:['4']);
      return '<html><body><script>var visitor_name="Alex59",dle_login_hash="test-only";</script><div class="tabs--center" data-user="Alex59" data-kind="owned"></div><h1 class="ncard__main-title">Карточки пользователя Alex59 ('+ids.length+' шт.)</h1>'+
      ids.map(id=>`<div class="anime-cards__item" data-rank="${id==='3'?'a_plus':'a'}" data-owner-id="${id}"><button class="lock-card-btn"><i class="fal ${locked.has(id)?'fa-lock':'fa-unlock'}"></i></button></div>`).join('')+
      (!filtered&&n===1?'<a href="/user/cards/?name=Alex59&page=2&rank=a">2</a>':'')+'</body></html>';
    };
    await page.route('**/*',async route=>{
      const r=route.request(),u=new URL(r.url());
      if(u.pathname==='/user/cards/'){
        const filtered=u.searchParams.get('locked')==='0';
        if(filtered){filteredReads.push(u.searchParams.get('page'));assert.equal(u.searchParams.get('rank'),'a');}
        return route.fulfill({contentType:'text/html',body:html(Number(u.searchParams.get('page')) || 1,filtered)});
      }
      if(u.pathname==='/ajax/page_lock_cards/' && r.method()==='POST') {
        const body=new URLSearchParams(r.postData());assert.equal(body.get('user_hash'),'test-only');
        const ids=body.getAll('ids[]');posts.push(ids);ids.forEach(id=>locked.add(id));
        return route.fulfill({contentType:'application/json',body:'{"status":"ok"}'});
      }
      if(u.pathname==='/ajax/page_unlock_cards/' && r.method()==='POST') {
        const body=new URLSearchParams(r.postData());assert.equal(body.get('user_hash'),'test-only');
        const ids=body.getAll('ids[]');unlockPosts.push(ids);ids.forEach(id=>locked.delete(id));
        return route.fulfill({contentType:'application/json',body:'{"status":"ok"}'});
      }
      throw new Error('Unexpected network request: '+r.url());
    });
    await page.goto('https://animesss.com/user/cards/?name=Alex59');
    await page.evaluate(()=>{const original=window.setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===1500?5:ms,...args);});
    const bookmark=fs.readFileSync(require.resolve('../mobile-lock-bookmark.txt'),'utf8').trim();
    await page.evaluate(url=>{location.href=url;},bookmark);
    await page.getByRole('button',{name:'Вся коллекция — по страницам'}).waitFor();
    assert.equal(posts.length,0);
    page.on('dialog',d=>d.accept());
    await page.getByRole('button',{name:'Вся коллекция — по страницам'}).click();
    await page.waitForFunction(()=>document.querySelector('#as-mobile-lock textarea')?.value.includes('Готово:'));
    assert.deepEqual(posts,[['1'],['4']]);
    const log=await page.getByLabel('Лог блокировки').inputValue();
    assert.match(log,/Страница 2: новых блокировок 1/);
    assert.match(log,/Готово: заблокировано 2, уже было 1/);
    assert.ok((await page.evaluate(()=>localStorage.getItem('animesss.mobileLock.log:Alex59'))).includes('Готово:'));
    assert.ok(!locked.has('3'),'A+ is never locked');
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    await page.evaluate(()=>localStorage.removeItem('animesss.mobileLock.log:Alex59'));
    locked.clear();locked.add('2');posts.length=0;
    await page.evaluate(url=>{location.href=url;},bookmark);
    await page.getByRole('button',{name:'Незаблокированные — первая страница'}).click();
    await page.waitForFunction(()=>document.querySelector('#as-mobile-lock textarea')?.value.includes('Готово:'));
    assert.deepEqual(posts,[['1'],['4']]);
    assert.ok(filteredReads.length>=4);
    assert.ok(filteredReads.every(p=>p==='1'));
    assert.match(await page.getByLabel('Лог блокировки').inputValue(),/Готово: заблокировано 2/);
    await page.getByRole('button',{name:'Разблокировать только сделанное закладкой'}).click();
    await page.waitForFunction(()=>document.querySelector('#as-mobile-lock textarea')?.value.includes('Готово: разблокировано 2'));
    assert.deepEqual(unlockPosts,[['1'],['4']]);
    assert.ok(locked.has('2'),'manual lock must remain locked');
    assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('animesss.mobileLock.owned.v1:Alex59'))),{});
    await page.getByRole('button',{name:'Разблокировать только сделанное закладкой'}).click();
    await page.waitForFunction(()=>document.querySelector('#as-mobile-lock textarea')?.value.includes('нет подтверждённых блокировок'));
    assert.equal(unlockPosts.length,2);
  }finally{await browser.close();}
});
