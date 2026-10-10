const test=require('node:test');
const assert=require('node:assert/strict');
let chromium;try{({chromium}=require('playwright'));}catch{}
test('coordinate controls center the view, validate input and load the chosen area without moving player',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page=await browser.newPage();
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<header><a href="/user/Tester/">Коллекция</a></header>'}));
    await page.goto('https://animesss.com/labyrinth/');
    await page.evaluate(()=>{
      window.requests=[];window.gameKeys=[];
      document.addEventListener('keydown',e=>window.gameKeys.push(e.key));
      window.chrome={runtime:{id:'fixture',sendMessage:async msg=>{
        window.requests.push(msg);return {ok:true,rooms:[{...msg.nearby,event:'reward'}],next:null};
      }},storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener(){}}}};
    });
    await page.addScriptTag({path:require.resolve('../labyrinth.js')});
    await page.getByRole('button',{name:'🧭 Карта лабиринта'}).click();
    const x=page.getByLabel('Координата X'),y=page.getByLabel('Координата Y');
    assert.equal(await x.count(),1,'coordinate controls must be available');
    await x.fill('-250');await y.fill('370');
    await page.getByRole('button',{name:'Загрузить ±100 от точки',exact:true}).click();
    await page.waitForFunction(()=>window.requests.length===1);
    assert.deepEqual(await page.evaluate(()=>window.requests[0].nearby),{x:-250,y:370});
    await page.evaluate(()=>window.postMessage({type:'animesss-local-map-v1',map:{current:{x:0,y:0},steps:[{x:0,y:0,event:'start'},{x:-250,y:370,event:'reward'}]}},location.origin));
    await page.waitForTimeout(30);
    const target=page.getByRole('button',{name:'-250, 370: Награда',exact:true});
    await target.waitFor();
    await y.press('Enter');
    assert.equal(await page.getByRole('button',{name:'0, 0: Старт',exact:true}).count(),0);
    assert.equal(await target.evaluate(el=>el.classList.contains('here')),false);
    assert.deepEqual(await page.evaluate(()=>window.gameKeys),[]);
    assert.equal(await page.evaluate(()=>window.requests.length),1,'show must not request cloud data');
    const before=await target.boundingBox();
    await x.fill('');await page.getByRole('button',{name:'Показать',exact:true}).click();
    const offset=await target.evaluate(el=>{
      const cell=el.getBoundingClientRect(),view=el.getRootNode().getElementById('view').getBoundingClientRect();
      return {x:cell.x-view.x-view.width/2,y:cell.y-view.y-view.height/2};
    });
    assert.ok(Math.abs(offset.x+22)<1 && Math.abs(offset.y+22)<1,'invalid coordinates must not change map center');
    await x.fill('1.5');await page.getByRole('button',{name:'Загрузить ±100 от точки',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.requests.length),1);
    await page.getByRole('button',{name:'Моя позиция',exact:true}).click();
    const player=page.getByRole('button',{name:'0, 0: Старт',exact:true});
    await player.waitFor();assert.equal(await player.evaluate(el=>el.classList.contains('here')),true);
    assert.equal((await player.boundingBox()).width,before.width,'zoom must remain unchanged');
    await page.evaluate(()=>{window.chrome.runtime.sendMessage=msg=>new Promise(resolve=>{
      window.finishMap=()=>resolve({ok:true,rooms:[{...msg.nearby,event:'reward'}],next:null});
    });});
    await x.fill('-250');await y.fill('370');
    await page.getByRole('button',{name:'Загрузить ±100 от точки',exact:true}).click();
    await page.getByRole('button',{name:'Моя позиция',exact:true}).click();
    await page.evaluate(()=>window.finishMap());
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('div')).find(el=>el.shadowRoot)?.shadowRoot.getElementById('coordinateLoad').disabled);
    assert.equal(await player.count(),1,'late cloud response must not override return to player');
  } finally {await browser.close();}
});
