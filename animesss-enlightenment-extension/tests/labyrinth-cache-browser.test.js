const test = require('node:test');
const assert = require('node:assert/strict');
let chromium; try { ({chromium} = require('playwright')); } catch {}

test('shared map survives reload, merges areas and manual refresh preserves cache on blocked', {skip: !chromium}, async () => {
  const browser = await chromium.launch({headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage();
    await page.route('**/*', r => r.fulfill({contentType: 'text/html', body: '<header><a href="/user/Tester/">Коллекция</a></header>'}));
    await page.addInitScript(() => {
      window.requests = [];
      window.chrome = {runtime: {id: 'fixture', sendMessage: async msg => {
        window.requests.push(msg);
        return window.blocked ? {ok: false, error: 'загрузка карты: blocked'} :
          {ok: true, rooms: [{...msg.nearby, event: window.roomEvent || 'reward'}], next: null};
      }}, storage: {local: {get: async () => ({}), set: async () => {}}, onChanged: {addListener() {}}}};
    });
    const open = async () => {
      await page.goto('https://animesss.com/labyrinth/');
      await page.addScriptTag({path: require.resolve('../labyrinth.js')});
      await page.getByRole('button', {name: '🧭 Карта лабиринта'}).click();
    };
    const idle = () => page.waitForFunction(() => !Array.from(document.querySelectorAll('div')).find(e => e.shadowRoot)?.shadowRoot.getElementById('coordinateLoad').disabled);
    const area = async (x) => {
      await page.getByLabel('Координата X').fill(String(x));
      await page.getByLabel('Координата Y').fill('0');
      await page.getByRole('button', {name: 'Загрузить ±100 от точки', exact: true}).click();
      await idle();
    };
    await open();
    await area(0);
    await area(1);
    await open();
    assert.equal(await page.getByRole('button', {name: '0, 0: Награда', exact: true}).count(), 1, 'previous area must survive reload');
    assert.equal(await page.getByRole('button', {name: '1, 0: Награда', exact: true}).count(), 1);
    assert.equal(await page.evaluate(() => window.requests.length), 0, 'restoration must not request server');
    await page.evaluate(() => { window.blocked = true; });
    const refresh = page.getByRole('button', {name: 'Обновить данные с сервера', exact: true});
    await refresh.click(); await idle();
    assert.deepEqual(await page.evaluate(() => window.requests[0].nearby), {x: 1, y: 0}, 'refresh remembers last area');
    assert.equal(await page.getByRole('button', {name: '0, 0: Награда', exact: true}).count(), 1);
    assert.match(await page.locator('#cloudStatus').textContent(), /blocked/);
    assert.match(await page.locator('#cacheStatus').textContent(), /кэш/i);
    await page.evaluate(() => { window.blocked = false; window.roomEvent = 'quiz'; });
    await refresh.click(); await idle();
    await open();
    assert.equal(await page.getByRole('button', {name: '1, 0: Викторина', exact: true}).count(), 1, 'fresh data replaces cached event');
    assert.equal(await page.getByRole('button', {name: '0, 0: Награда', exact: true}).count(), 1, 'other area retained');
    await page.evaluate(() => {
      window.chrome.runtime.sendMessage = async msg => msg.cursor ? {ok:false,error:'blocked'} :
        {ok:true,rooms:[{x:2,y:0,event:'empty'}],next:{x:2,y:0}};
    });
    await page.getByRole('button', {name:'Загрузить всю общую карту',exact:true}).click(); await idle();
    await open();
    assert.equal(await page.getByRole('button', {name:'2, 0: Пусто',exact:true}).count(),1,'successful page persists even when following page fails');
    assert.equal(await page.getByRole('button', {name:'0, 0: Награда',exact:true}).count(),1);
    await page.evaluate(() => { window.blocked = true; });
    await refresh.click(); await idle();
    assert.equal(await page.evaluate(() => window.requests[0].nearby), undefined, 'full-map refresh remains full after reload');
    await page.evaluate(() => {
      window.chrome.runtime.sendMessage = async () => ({ok:true,rooms:[{x:3,y:0,event:'quiz'}],next:null});
      IDBDatabase.prototype.transaction = () => { throw new Error('quota exhausted'); };
    });
    await refresh.click(); await idle();
    assert.match(await page.locator('#cacheStatus').textContent(), /Кэш не сохранён/);
    assert.equal(await page.getByRole('button', {name:'3, 0: Викторина',exact:true}).count(),1,'storage failure must not hide newly received rooms');
    await open();
    assert.equal(await page.getByRole('button', {name:'2, 0: Пусто',exact:true}).count(),1,'failed write must leave older cache intact');
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      let first = true;
      IDBDatabase.prototype.transaction = function(...args) {
        if(first) { first = false; throw new Error('temporary storage failure'); }
        return original.apply(this,args);
      };
      window.chrome.runtime.sendMessage = async msg => msg.cursor ?
        {ok:true,rooms:[{x:4,y:0,event:'quiz'}],next:null} :
        {ok:true,rooms:[{x:3,y:0,event:'quiz'}],next:{x:3,y:0}};
    });
    await refresh.click(); await idle();
    assert.equal(await page.getByRole('button', {name:'3, 0: Викторина',exact:true}).count(),1,'next successful write must not erase earlier unsaved page');
    await open();
    assert.equal(await page.getByRole('button', {name:'3, 0: Викторина',exact:true}).count(),1,'pending page is retried and persisted');
    assert.equal(await page.getByRole('button', {name:'4, 0: Викторина',exact:true}).count(),1);
    await page.evaluate(() => { delete window.chrome.runtime; });
    await refresh.click(); await idle();
    assert.match(await page.locator('#cloudStatus').textContent(), /перезагрузите страницу/i);
    assert.doesNotMatch(await page.locator('#cloudStatus').textContent(), /Cannot read/);
    assert.equal(await page.getByRole('button', {name:'4, 0: Викторина',exact:true}).count(),1,'lost extension context must keep cached map visible');
    await page.evaluate(() => {
      window.chrome.runtime = {id:'fixture',sendMessage:async()=>{throw new Error('Extension context invalidated.');}};
    });
    await refresh.click(); await idle();
    assert.match(await page.locator('#cloudStatus').textContent(), /перезагрузите страницу/i);
    assert.doesNotMatch(await page.locator('#cloudStatus').textContent(), /Extension context invalidated/);
    // A different account must never see this profile's cache.
    await page.route('**/*', r => r.fulfill({contentType: 'text/html', body: '<header><a href="/user/Other/">Коллекция</a></header>'}));
    await open();
    assert.equal(await page.getByRole('button', {name: '0, 0: Награда', exact: true}).count(), 0);
  } finally { await browser.close(); }
});
