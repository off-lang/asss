const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let chromium;try{({chromium}=require('playwright'));}catch{}
const tradeStats='<div class="card-stats"><span title="Владельцев"><i class="fas fa-users"></i>114</span><span title="Хотят получить"><i class="fas fa-heart"></i>189</span><span title="Готовы обменять"><i class="fas fa-sync-alt"></i>22</span><span title="Дубли на руках"><i class="fas fa-copy"></i>0</span></div>';
const shopStats='<div class="labyrinth-card-stats accshop-card-stats"><span title="Владельцев: 1 944" aria-label="Владельцев: 1 944" role="img"><b>2к</b><small>Владельцы</small></span><span title="Хотят получить: 0" aria-label="Хотят получить: 0" role="img"><b>0</b><small>Желают</small></span><span title="Готовы обменять: 251" aria-label="Готовы обменять: 251" role="img"><b>251</b><small>Обмен</small></span><span title="Дубли на руках: 0"><b>0</b><small>Дубли</small></span></div>';
test('native stats suppress only matching cards and dynamically restore extension fallback without observer loops',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page=await browser.newPage();
    await page.setContent(`<div id="accshopCardsWrap"><article class="accshop__card" id="shop"><div class="accshop__card-metrics">${shopStats}</div><button class="accshop__buy-btn" data-card-id="1"></button></article></div><a id="trade" class="trade__main-item" href="/cards/users/?id=2">${tradeStats}<section class="animesss-enlightenment-card-stats">old duplicate</section></a><div id="plain" class="anime-cards__item" data-id="3"></div><div id="hidden" class="anime-cards__item" data-id="4"><div hidden>${tradeStats}</div></div><div id="partial" class="anime-cards__item" data-id="5"><div class="card-stats"><span title="Хотят получить">—</span></div></div>`);
    await page.addStyleTag({path:require.resolve('../content.css')});
    await page.addScriptTag({path:require.resolve('../card-helper.js')});
    await page.evaluate(source=>{
      const api=new Function('const window=undefined;const module={exports:{}};'+source+';return module.exports;')();
      window.calls=[];window.renders=0;window.batches=0;
      const render=api.createCardStatsRenderer(document,'https://animesss.com');
      window.coord=AnimesssCardHelper.createCardStatsCoordinator({client:{load:async id=>{calls.push(id);return {status:'ready',ownersCount:8,needCount:0,tradeCount:3,duplicates:1};}},instanceStore:{lookup:()=>null,remember:async()=>{}},render:(...args)=>{renders++;render(...args);}});
      window.observer=AnimesssCardHelper.createCardObserver({root:document.body,selector:AnimesssCardHelper.CARD_SELECTOR,schedule:fn=>setTimeout(fn,0),onCards:cards=>{batches++;void coord.process(cards);},Observer:MutationObserver});
      observer.scan();
    },fs.readFileSync(require.resolve('../content.js'),'utf8'));
    await page.waitForFunction(()=>document.querySelector('#partial .animesss-enlightenment-card-stats'));
    assert.deepEqual(await page.evaluate(()=>calls),['3','4','5']);
    assert.equal(await page.locator('#trade .animesss-enlightenment-card-stats').count(),0);
    assert.equal(await page.locator('#shop .animesss-enlightenment-card-stats').count(),0);
    await page.evaluate(()=>coord.process([...document.querySelectorAll(AnimesssCardHelper.CARD_SELECTOR)],{force:true}));
    assert.deepEqual(await page.evaluate(()=>calls),['3','4','5','3','4','5']);
    // Native data arriving after our rendering removes only our own block.
    await page.evaluate(html=>document.querySelector('#plain').insertAdjacentHTML('beforeend',html),tradeStats);
    await page.waitForFunction(()=>!document.querySelector('#plain .animesss-enlightenment-card-stats'));
    assert.equal(await page.locator('#plain .card-stats').count(),1);
    // Removal (subscription ending / filter change) restores retained stats without a new request.
    await page.evaluate(()=>document.querySelector('#plain .card-stats').remove());
    await page.waitForFunction(()=>document.querySelector('#plain .animesss-enlightenment-card-stats'));
    assert.equal(await page.evaluate(()=>calls.length),6);
    // Visibility changes also switch ownership; zeros are valid native counters.
    await page.evaluate(()=>document.querySelector('#hidden > [hidden]').hidden=false);
    await page.waitForFunction(()=>!document.querySelector('#hidden .animesss-enlightenment-card-stats'));
    await page.evaluate(()=>document.querySelector('#hidden > div').hidden=true);
    await page.waitForFunction(()=>document.querySelector('#hidden .animesss-enlightenment-card-stats'));
    const batches=await page.evaluate(()=>window.batches);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.batches),batches,'rendering must not trigger observer loops');
    assert.equal(await page.locator('#plain .animesss-enlightenment-card-metric[aria-label="Хотят: 0"]').count(),1);
    await page.evaluate(source=>{
      const api=new Function('const window=undefined;const module={exports:{}};'+source+';return module.exports;')();
      const render=api.createCardStatsRenderer(document,'https://animesss.com');
      const card=document.querySelector('#plain');
      render(card,{status:'ready',ownersCount:1944,needCount:999,tradeCount:9876,duplicates:1});
      render(card,{owners:{status:'ready',count:100,duplicates:999},need:{status:'ready',count:0},trade:{status:'ready',count:0}});
    },fs.readFileSync(require.resolve('../content.js'),'utf8'));
    assert.equal(await page.locator('#plain [aria-label="Дубли: 1"]').count(),1,'legacy owners totals must not overwrite personal copies');
    await page.addStyleTag({content:'body{background:#141414;color:#ddd;font-family:Arial}#plain{width:160px}#hidden{width:300px}'});
    const layout=await page.evaluate(()=>['plain','hidden'].map(id=>[...document.querySelectorAll(`#${id} .animesss-enlightenment-card-metric`)].map(el=>el.getBoundingClientRect().top)));
    assert.equal(layout[0][0],layout[0][1]);
    assert.ok(layout[0].every(top=>top===layout[0][0]),'narrow cards also use one compact row');
    assert.equal(await page.locator('#plain .animesss-enlightenment-card-metric small').count(),0);
    assert.ok(layout[1].every(top=>top===layout[1][0]),'wide cards use one row');
    assert.ok(await page.evaluate(()=>[...document.querySelectorAll('#plain .animesss-enlightenment-card-metric')].every(el=>el.scrollWidth<=el.clientWidth)),'large counters fit narrow cards');
    await page.screenshot({path:'/tmp/animesss-native-stats-test.png'});
    const before=await page.locator('#hidden .animesss-enlightenment-card-metric b').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
    await page.addStyleTag({path:require.resolve('../pack-stats.css')});
    const after=await page.locator('#hidden .animesss-enlightenment-card-metric b').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
    assert.ok(after>before,'pack counters are larger on wide cards');
    assert.equal(await page.locator('#plain .animesss-enlightenment-card-metric b').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),before,'mobile cards keep their compact size');
    // History thumbnails are much narrower than inventory cards. Reserve real
    // icon width even though this offline fixture has no site icon font.
    await page.addStyleTag({content:'#plain{width:100px}#plain i{display:inline-block;width:9px;flex-shrink:0}'});
    const mini=await page.evaluate(()=>[...document.querySelectorAll('#plain .animesss-enlightenment-card-metric')].map(el=>({top:el.getBoundingClientRect().top,fits:el.scrollWidth<=el.clientWidth})));
    assert.equal(mini[0].top,mini[1].top);
    assert.ok(mini[2].top>mini[0].top,'history thumbnails show two rows');
    assert.equal(mini[2].top,mini[3].top);
    assert.ok(mini.every(el=>el.fits),'history numbers never overlap adjacent icons');
  }finally{await browser.close();}
});

test('personal duplicates use the filtered collection total, not a partial owners list',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page=await browser.newPage();
    await page.addScriptTag({path:require.resolve('../card-helper.js')});
    const results=await page.evaluate(async()=>{
      const cases=[['Alex59','1','1',1],['Alex59','0','2',0],['Alex59','75','3',75],['Other','8','4',null],['Alex59','—','5',null]];
      const out=[];
      for(const [profile,total,id,want] of cases){
        const urls=[];
        const client=AnimesssCardHelper.createCardStatsClient({origin:'https://animesss.com',collectionName:'Alex59',
          fetch:async url=>{urls.push(String(url));return {ok:true,text:async()=>String(url).includes('/user/cards/')?`<h1 class="ncard__main-title">Карточки пользователя <a href="/user/${profile}/">${profile}</a> <span>(${total} шт.)</span></h1>`:'<b id="owners-count">100</b><b id="owners-need">3</b><b id="owners-trade">4</b>'};},
          parseHtml:html=>new DOMParser().parseFromString(html,'text/html'),cache:{get:async()=>null,set:async()=>{}},sleep:async()=>{}});
        const result=await client.load(id);
        out.push({value:result.duplicates,want,urls,owners:result.ownersCount});
      }return out;
    });
    for(const [index,result] of results.entries()){
      assert.equal(result.value,result.want);
      assert.equal(result.owners,100);
      assert.ok(result.urls.includes(`https://animesss.com/user/cards/?name=Alex59&card_id=${index+1}`));
      assert.equal(result.urls.length,2,'main statistics and one collection request only');
    }
  }finally{await browser.close();}
});
