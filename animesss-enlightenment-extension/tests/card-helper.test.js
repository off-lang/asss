'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CARD_SELECTOR,
  createCardObserver,
  createCardStatsCoordinator,
  createCardStatsClient,
  createAutoLootController,
  createChatCrystalController,
  createClubBoostController,
  createClubBoostJournal,
  createInstanceMap,
  createInstanceMapStore,
  createMassTradeController,
  createTtlCache,
  extractUserHash,
  getCanonicalCardId,
  parseCardStats,
  collectTradeCandidates,
} = require('../card-helper.js');

function fakeCard({ className = '', attrs = {}, href = '' } = {}) {
  return {
    className,
    tagName: href ? 'A' : 'DIV',
    getAttribute(name) {
      if (name === 'href' && href) return href;
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    hasAttribute(name) {
      return (name === 'href' && Boolean(href)) || Object.hasOwn(attrs, name);
    },
    matches(selector) {
      return selector.split(',').some((part) =>
        part.trim().slice(1) === className
      );
    },
    querySelector() {
      return href ? { getAttribute: () => href } : null;
    },
  };
}

test('CARD_SELECTOR includes every supported card surface once', () => {
  assert.deepEqual(CARD_SELECTOR.split(', ').sort(), [
    '.anime-cards__item',
    '.accshop__buy-btn[data-card-id]',
    '.card-filter-list__card',
    '.card-pack__card',
    '.deck__item',
    '.history__body-item',
    '.lootbox__card',
    '.remelt__inventory-item',
    '.trade__inventory-item',
    '.trade__main-item',
  ].sort());
});

test('getCanonicalCardId resolves attributes and supported card links', () => {
  const cases = [
    [fakeCard({ className: 'anime-cards__item', attrs: { 'data-id': '17' } }), '17'],
    [fakeCard({ className: 'deck__item', attrs: { 'data-card-id': '23' } }), '23'],
    [fakeCard({ className: 'history__body-item', attrs: { 'card-id': '31' } }), '31'],
    [fakeCard({ className: 'card-pack__card', href: '/cards/users/?id=44' }), '44'],
    [fakeCard({ className: 'card-filter-list__card', href: '/cards/55/users/' }), '55'],
    [fakeCard({ className: 'accshop__buy-btn', attrs: { 'data-card-id': '77' } }), '77'],
  ];

  for (const [element, expected] of cases) {
    assert.equal(getCanonicalCardId(element, () => null), expected);
  }
});

test('getCanonicalCardId never treats a remelt instance ID as canonical', () => {
  const known = fakeCard({
    className: 'remelt__inventory-item',
    attrs: { 'data-id': 'instance-8' },
  });
  const unknown = fakeCard({
    className: 'remelt__inventory-item',
    attrs: { 'data-id': 'unknown' },
  });

  assert.equal(
    getCanonicalCardId(known, (id) => id === 'instance-8' ? '88' : null),
    '88',
  );
  assert.equal(getCanonicalCardId(unknown, () => null), null);
});

test('getCanonicalCardId rejects malformed and nonnumeric IDs', () => {
  assert.equal(
    getCanonicalCardId(fakeCard({ attrs: { 'data-id': '7 & 8' } }), () => null),
    null,
  );
  assert.equal(
    getCanonicalCardId(fakeCard({ href: '/cards/users/?id=bad' }), () => null),
    null,
  );
});

function owner(href, name, copies = '1') {
  return {
    href,
    textContent: name,
    getAttribute(name) {
      return name === 'data-count' ? copies : null;
    },
    querySelector(selector) {
      if (selector === '.card-show__owner-name') return { textContent: name };
      return null;
    },
  };
}

function statsDocument({ counters = {}, owners = [], duplicates = null } = {}) {
  return {
    querySelector(selector) {
      if (Object.hasOwn(counters, selector)) {
        return { textContent: String(counters[selector]) };
      }
      if (selector === '[title="Дубли на руках"]' && duplicates !== null) {
        return { textContent: `Дубли ${duplicates}` };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.ncard__owners-list .card-show__owner') return owners;
      return [];
    },
  };
}

test('parseCardStats uses authoritative counters and safe unique owners', () => {
  const first = owner('https://animesss.com/user/alex/', 'Alex', '2');
  const duplicate = owner('https://animesss.com/user/alex/', 'Alex', '1');
  const unsafe = owner('https://evil.example/user/bad/', 'Bad');
  const doc = statsDocument({
    counters: {
      '#owners-count': '12',
      '#owners-need': '7',
      '#owners-trade': '4',
    },
    owners: [first, duplicate, unsafe],
    duplicates: 3,
  });

  assert.deepEqual(parseCardStats(doc, 'https://animesss.com'), {
    ownersCount: 12,
    needCount: 7,
    tradeCount: 4,
    duplicates: 3,
    users: {
      owners: [{
        name: 'Alex',
        url: 'https://animesss.com/user/alex/',
        copies: 2,
      }],
      need: [],
      trade: [],
    },
  });
});

test('trade inventory instance ids are never used as canonical ids',()=>{
  const card=fakeCard({className:'trade__inventory-item user__donthave__card',attrs:{'data-id':'178746853'}});
  assert.equal(getCanonicalCardId(card),null);
  assert.equal(getCanonicalCardId(card,id=>id==='178746853'?'3124':null),'3124');
  assert.equal(getCanonicalCardId(fakeCard({className:'trade__inventory-item',attrs:{'data-id':'178746853','data-original-id':'25'}})),'25');
});

test('trade resolver indexes own collection pages and reuses all discovered mappings',async()=>{
  const urls=[];
  const store=createInstanceMapStore({storage:memoryStorage(),key:'instances'});
  let page=0;
  const client=createCardStatsClient({origin:'https://animesss.com',
    collectionName:'Alex59',collectionRank:'b',instanceStore:store,
    fetch:async url=>{urls.push(url);return {ok:true,text:async()=>''};},
    parseHtml:()=>{page++;return {querySelectorAll:selector=>selector==='a[href]'
      ? (page===1?[fakeCard({href:'/user/cards/?name=Alex59&page=2&rank=b'})]:[])
      : [fakeCard({attrs:{'data-owner-id':page===1?'178746851':'178746853','data-id':page===1?'25':'3124'}})]};},
    cache:{get:async()=>null,set:async()=>{}},sleep:async()=>{}});
  assert.equal(await client.resolveInstance('178746853'),'3124');
  assert.equal(await client.resolveInstance('178746851'),'25');
  assert.equal(await client.resolveInstance('999999999'),null);
  assert.equal(store.lookup('178746853'),'3124');
  assert.deepEqual(urls,[
    'https://animesss.com/user/cards/?name=Alex59&rank=b&page=1',
    'https://animesss.com/user/cards/?name=Alex59&rank=b&page=2',
  ]);
});

test('initial trade markup saves mappings before filtering removes data-card-id',async()=>{
  const store=createInstanceMapStore({storage:memoryStorage(),key:'instances'});
  await store.remember([fakeCard({className:'trade__inventory-item',attrs:{'data-id':'178746853','data-card-id':'3124'}})]);
  assert.equal(getCanonicalCardId(fakeCard({className:'trade__inventory-item',attrs:{'data-id':'178746853'}}),store.lookup),'3124');
});

test('a page without card statistics does not become zero counts',()=>{
  const stats=parseCardStats(statsDocument({}),'https://animesss.com');
  assert.equal(stats.ownersCount,null);assert.equal(stats.needCount,null);
  assert.equal(stats.tradeCount,null);assert.equal(stats.duplicates,null);
});

test('parseCardStats falls back to list size when counters are absent', () => {
  const doc = statsDocument({
    owners: [
      owner('https://animesss.com/user/a/', 'A'),
      owner('https://animesss.com/user/b/', 'B'),
    ],
  });

  const result = parseCardStats(doc, 'https://animesss.com');
  assert.equal(result.ownersCount, 2);
  assert.equal(result.needCount, null);
  assert.equal(result.tradeCount, null);
  assert.equal(result.duplicates, null, 'other users are not the signed-in user’s duplicates');
});

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(entries) {
      Object.assign(values, entries);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async getAll() {
      return { ...values };
    },
  };
}

test('createTtlCache returns fresh values and expires stale entries', async () => {
  let clock = 1000;
  const storage = memoryStorage();
  const cache = createTtlCache({
    storage,
    now: () => clock,
    prefix: 'helper.stats.',
    ttlMs: 500,
  });

  await cache.set('17', { ownersCount: 2 });
  assert.deepEqual(await cache.get('17'), { ownersCount: 2 });

  clock = 1501;
  assert.equal(await cache.get('17'), null);
  assert.equal(storage.values['helper.stats.17'], undefined);
});

test('createTtlCache clear removes only its own prefixed entries', async () => {
  const storage = memoryStorage({
    'helper.stats.1': { value: 1, expiresAt: 9999 },
    'helper.stats.2': { value: 2, expiresAt: 9999 },
    'site.setting': true,
  });
  const cache = createTtlCache({
    storage,
    now: () => 1,
    prefix: 'helper.stats.',
    ttlMs: 500,
  });

  await cache.clear();

  assert.deepEqual(storage.values, { 'site.setting': true });
});

function httpResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    async text() {
      return body;
    },
  };
}

function valueCache() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

const completeStats = {
  ownersCount: 12,
  needCount: 7,
  tradeCount: 4,
  duplicates: 3,
  users: {
    owners: [{ name: 'Owner', url: 'https://animesss.com/user/owner/', copies: 1 }],
    need: [{ name: 'Need', url: 'https://animesss.com/user/need/', copies: 1 }],
    trade: [{ name: 'Trade', url: 'https://animesss.com/user/trade/', copies: 1 }],
  },
};

test('card stats client deduplicates concurrent loads and honors cache unless forced', async () => {
  let fetches = 0;
  const client = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async () => {
      fetches += 1;
      return httpResponse('MAIN');
    },
    parseHtml: (body) => body,
    parseStats: () => completeStats,
    cache: valueCache(),
    sleep: async () => {},
  });

  const [first, second] = await Promise.all([
    client.load('17'),
    client.load('17'),
  ]);
  assert.equal(fetches, 1);
  assert.deepEqual(first, { status: 'ready', ...completeStats });
  assert.deepEqual(second, first);

  await client.load('17');
  assert.equal(fetches, 1);
  await client.load('17', { force: true });
  assert.equal(fetches, 2);
});

test('card stats client retries a transient 503 and does not retry a permanent 404', async () => {
  const waits = [];
  let transientCalls = 0;
  const transient = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async () => {
      transientCalls += 1;
      return transientCalls === 1 ? httpResponse('', 503) : httpResponse('MAIN');
    },
    parseHtml: (body) => body,
    parseStats: () => completeStats,
    cache: valueCache(),
    sleep: async (ms) => waits.push(ms),
  });

  assert.equal((await transient.load('17')).status, 'ready');
  assert.equal(transientCalls, 2);
  assert.deepEqual(waits, [1000, 350]);

  let permanentCalls = 0;
  const permanent = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async () => {
      permanentCalls += 1;
      return httpResponse('', 404);
    },
    parseHtml: (body) => body,
    parseStats: () => completeStats,
    cache: valueCache(),
    sleep: async () => {},
  });
  assert.equal((await permanent.load('17')).status, 'error');
  assert.equal(permanentCalls, 1);
});

test('card stats client uses main counters without requesting unused user lists', async () => {
  const urls = [];
  const partialStats = {
    ...completeStats,
    users: { owners: completeStats.users.owners, need: [], trade: [] },
  };
  const needUser = {
    name: 'Need',
    url: 'https://animesss.com/user/need/',
    copies: 1,
  };
  const tradeUser = {
    name: 'Trade',
    url: 'https://animesss.com/user/trade/',
    copies: 1,
  };
  const client = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async (url) => {
      urls.push(url);
      if (url.includes('/need/')) return httpResponse('NEED');
      if (url.includes('/trade/')) return httpResponse('TRADE');
      return httpResponse('MAIN');
    },
    parseHtml: (body) => body,
    parseStats: (body) => {
      if (body === 'NEED') {
        return { ...partialStats, users: { owners: [needUser], need: [], trade: [] } };
      }
      if (body === 'TRADE') {
        return { ...partialStats, users: { owners: [tradeUser], need: [], trade: [] } };
      }
      return partialStats;
    },
    cache: valueCache(),
    sleep: async () => {},
  });

  const result = await client.load('17');

  assert.deepEqual(urls, [
    'https://animesss.com/cards/users/?id=17',
  ]);
  assert.equal(result.ownersCount, 12);
  assert.equal(result.needCount, 7);
  assert.equal(result.tradeCount, 4);
  assert.deepEqual(result.users.need, []);
  assert.deepEqual(result.users.trade, []);
});

test('coordinator renders main counters while the personal-copy request is pending', async () => {
  let release, started;
  const pending=new Promise(resolve=>{release=resolve;});
  const personalStarted=new Promise(resolve=>{started=resolve;});
  const updates=[];
  const client=createCardStatsClient({origin:'https://animesss.com',collectionName:'Alex59',
    fetch:async url=>{
      if(url.includes('/user/cards/')){started();await pending;}
      return httpResponse('MAIN');
    },parseHtml:()=>({querySelector:()=>null}),
    parseStats:()=>({...completeStats,duplicates:null,users:{owners:[],need:[],trade:[]}}),
    cache:valueCache(),sleep:async()=>{}});
  const coordinator=createCardStatsCoordinator({client,instanceStore:{lookup:()=>null,remember:async()=>{}},render:(_card,data)=>updates.push(data)});
  const work=coordinator.process([fakeCard({className:'anime-cards__item',attrs:{'data-id':'17'}})]);
  await personalStarted;
  try {assert.equal(updates[0]?.needCount,7,'demand must display before duplicate response');}
  finally {release();await work;}
});

test('card stats client spaces network requests for about three per second', async () => {
  const events = [];
  const client = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async (url) => {
      events.push(`fetch:${new URL(url).searchParams.get('id')}`);
      return httpResponse('MAIN');
    },
    parseHtml: (body) => body,
    parseStats: () => completeStats,
    cache: valueCache(),
    sleep: async (ms) => events.push(`sleep:${ms}`),
  });

  await Promise.all([client.load('17'), client.load('18')]);

  assert.deepEqual(events, ['fetch:17', 'sleep:350', 'fetch:18']);
});

test('card stats client applies 1, 3, and 5 request-per-second modes', async () => {
  const waits = [];
  const client = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async () => httpResponse('MAIN'),
    parseHtml: (body) => body,
    parseStats: () => completeStats,
    cache: valueCache(),
    sleep: async (ms) => waits.push(ms),
  });

  assert.equal(typeof client.setRequestRate, 'function');
  if (typeof client.setRequestRate !== 'function') return;
  client.setRequestRate(1);
  await client.load('17');
  await client.load('18');
  client.setRequestRate(3);
  await client.load('19');
  client.setRequestRate(5);
  await client.load('20');

  assert.deepEqual(waits, [1000, 350, 200]);
});

test('card stats client respects Retry-After after a 429 response', async () => {
  const waits = [];
  let calls = 0;
  const client = createCardStatsClient({
    origin: 'https://animesss.com',
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? httpResponse('', 429, { 'retry-after': '5' })
        : httpResponse('MAIN');
    },
    parseHtml: (body) => body,
    parseStats: () => completeStats,
    cache: valueCache(),
    sleep: async (ms) => waits.push(ms),
  });

  assert.equal((await client.load('17')).status, 'ready');
  assert.deepEqual(waits, [5000, 350]);
});

test('createInstanceMap maps owned instance IDs to canonical card IDs', () => {
  const cards = [
    fakeCard({ attrs: { 'data-owner-id': 'instance-1', 'data-id': '17' } }),
    fakeCard({ attrs: { 'data-owner-id': 'instance-2', 'data-id': '23' } }),
    fakeCard({ attrs: { 'data-owner-id': '', 'data-id': '99' } }),
  ];

  assert.deepEqual(
    [...createInstanceMap(cards).entries()],
    [['instance-1', '17'], ['instance-2', '23']],
  );
});

test('card observer scans existing cards and batches unique added cards', () => {
  const existing = fakeCard({ className: 'anime-cards__item' });
  const added = fakeCard({ className: 'deck__item' });
  const batches = [];
  const scheduled = [];
  let mutationCallback;
  class FakeObserver {
    constructor(callback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const root = {
    querySelectorAll() {
      return [existing];
    },
  };
  const observer = createCardObserver({
    root,
    selector: CARD_SELECTOR,
    schedule: (callback) => scheduled.push(callback),
    onCards: (cards) => batches.push(cards),
    Observer: FakeObserver,
  });

  observer.scan();
  assert.deepEqual(batches, [[existing]]);

  const container = {
    nodeType: 1,
    matches: () => false,
    querySelectorAll: () => [added, added],
  };
  mutationCallback([
    { type: 'childList', addedNodes: [container] },
    { type: 'childList', addedNodes: [added] },
  ]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(batches, [[existing], [added]]);
});

test('card observer schedules a card again when its ID changes', () => {
  const changed = fakeCard({ className: 'trade__main-item' });
  const batches = [];
  const scheduled = [];
  let mutationCallback;
  class FakeObserver {
    constructor(callback) {
      mutationCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  createCardObserver({
    root: { querySelectorAll: () => [] },
    selector: CARD_SELECTOR,
    schedule: (callback) => scheduled.push(callback),
    onCards: (cards) => batches.push(cards),
    Observer: FakeObserver,
  });

  mutationCallback([{
    type: 'attributes',
    attributeName: 'data-id',
    target: changed,
  }]);
  scheduled.shift()();
  assert.deepEqual(batches, [[changed]]);
  for (const attributeName of ['data-card-id', 'card-id', 'data-original-id', 'data-owner-id', 'data-rank']) {
    mutationCallback([{type:'attributes',attributeName,target:changed}]);
    assert.equal(scheduled.length,1);
    scheduled.shift()();
  }
  assert.equal(batches.length,6);
});

test('instance map store persists mappings and resolves them after reload', async () => {
  const storage = memoryStorage({
    'helper.instances': { old: '7' },
  });
  const store = createInstanceMapStore({ storage, key: 'helper.instances' });
  await store.initialize();
  assert.equal(store.lookup('old'), '7');

  await store.remember([
    fakeCard({ attrs: { 'data-owner-id': 'new-instance', 'data-id': '17' } }),
  ]);

  assert.equal(store.lookup('new-instance'), '17');
  assert.deepEqual(storage.values['helper.instances'], {
    old: '7',
    'new-instance': '17',
  });
});

test('card stats coordinator renders recognized cards and forwards force refresh', async () => {
  const regular = fakeCard({
    className: 'deck__item',
    attrs: { 'data-id': '17' },
  });
  const remelt = fakeCard({
    className: 'remelt__inventory-item',
    attrs: { 'data-id': 'instance-8' },
  });
  const unknown = fakeCard({
    className: 'remelt__inventory-item',
    attrs: { 'data-id': 'missing' },
  });
  const loads = [];
  const renders = [];
  const coordinator = createCardStatsCoordinator({
    client: {
      async load(id, options) {
        loads.push([id, options]);
        return { status: 'ready', ownersCount: Number(id) };
      },
    },
    instanceStore: {
      remember: async () => {},
      lookup: (id) => id === 'instance-8' ? '88' : null,
    },
    render: (card, data) => renders.push([card, data]),
  });

  await coordinator.process([regular, remelt, unknown], { force: true });

  assert.deepEqual(loads, [
    ['17', { force: true }],
    ['88', { force: true }],
  ]);
  assert.deepEqual(renders.map(([card]) => card), [regular, remelt, unknown]);
  assert.equal(renders.at(-1)[1].ownersCount,null);
});

test('filter replacement restores stats by exact card image without reloading or resolving instance',async()=>{
  const image={getAttribute:name=>name==='src'?'/uploads/cards_image/197/b/ril.webp':null};
  const before=fakeCard({className:'trade__inventory-item',attrs:{'data-id':'178746853','data-original-id':'42'}});
  const after=fakeCard({className:'trade__inventory-item',attrs:{'data-id':'178746853'}});
  before.querySelector=after.querySelector=selector=>selector.startsWith('img')?image:null;
  let loads=0;const rendered=[];
  const coordinator=createCardStatsCoordinator({instanceStore:{remember:async()=>{},lookup:()=>null},
    client:{load:async()=>{loads++;return {status:'ready',needCount:167};},resolveInstance:()=>assert.fail('must reuse statistics')},
    render:(card,data)=>rendered.push({card,data})});
  await coordinator.process([before]);
  const pending=coordinator.process([after]);
  assert.equal(rendered.at(-1).card,after);
  assert.equal(rendered.at(-1).data.needCount,167);
  await pending;assert.equal(loads,1);
  await coordinator.process([after],{force:true});assert.equal(loads,2);
});

test('failed forced refresh preserves previously loaded counts',async()=>{
  const card=fakeCard({className:'deck__item',attrs:{'data-id':'42'}});
  let calls=0;const rendered=[];
  const coordinator=createCardStatsCoordinator({instanceStore:{remember:async()=>{},lookup:()=>null},
    client:{load:async()=>++calls===1?{status:'ready',needCount:77}:{status:'error',needCount:null}},
    render:(_,data)=>rendered.push(data)});
  await coordinator.process([card]);await coordinator.process([card],{force:true});
  assert.equal(rendered.at(-1).needCount,77);
  coordinator.clearRetained();await coordinator.process([card]);
  assert.equal(rendered.at(-1).status,'error');
});

test('disabling card stats stops queued cards after the active load', async () => {
  const first = fakeCard({ className: 'deck__item', attrs: { 'data-id': '17' } });
  const second = fakeCard({ className: 'deck__item', attrs: { 'data-id': '18' } });
  let releaseActive;
  const active = new Promise((resolve) => { releaseActive = resolve; });
  const loads = [];
  const renders = [];
  const coordinator = createCardStatsCoordinator({
    client: {
      async load(id) {
        loads.push(id);
        if (id === '17') await active;
        return { status: 'ready', ownersCount: Number(id) };
      },
    },
    instanceStore: { remember: async () => {}, lookup: () => null },
    render: (card) => renders.push(card),
  });

  assert.equal(typeof coordinator.setEnabled, 'function');
  if (typeof coordinator.setEnabled !== 'function') return;
  const processing = coordinator.process([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.setEnabled(false);
  releaseActive();
  await processing;

  assert.deepEqual(loads, ['17']);
  assert.deepEqual(renders, []);
});

function inlineScriptDocument(scripts) {
  return {
    querySelectorAll(selector) {
      return selector === 'script:not([src])'
        ? scripts.map((textContent) => ({ textContent }))
        : [];
    },
  };
}

test('extractUserHash reads valid inline configuration and rejects unsafe values', () => {
  assert.equal(
    extractUserHash(inlineScriptDocument(["var dle_login_hash = 'abc_123-XYZ';"])),
    'abc_123-XYZ',
  );
  assert.equal(
    extractUserHash(inlineScriptDocument(["window.dle_login_hash = 'short';"])),
    '',
  );
  assert.equal(
    extractUserHash(inlineScriptDocument(["var dle_login_hash = 'bad value!';"])),
    '',
  );
  assert.equal(extractUserHash(inlineScriptDocument(['const other = 1;'])), '');
});

test('auto-loot clicks a card notification and closes its modal', async () => {
  let cardClicks = 0;
  let closeClicks = 0;
  const scheduled = [];
  const notification = { click: () => { cardClicks += 1; } };
  const closeButton = { click: () => { closeClicks += 1; } };
  const root = {
    querySelector(selector) {
      if (selector === '.card-notification') return notification;
      if (selector.includes('.ui-dialog-titlebar-close')) return closeButton;
      return null;
    },
  };
  const observers = [];
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }
  const storage = memoryStorage();
  const controller = createAutoLootController({
    root,
    storage,
    Observer: FakeObserver,
    schedule: (callback) => scheduled.push(callback),
  });

  assert.equal(await controller.initialize(), false);
  assert.equal(cardClicks, 0);
  assert.equal(observers.length, 0);

  await controller.setEnabled(true);
  assert.equal(cardClicks, 1);
  assert.equal(observers.length, 1);
  assert.equal(storage.values['animesssCardHelper.autoLootEnabled'], true);

  scheduled.shift()();
  assert.equal(closeClicks, 1);
});

test('auto-loot handles each dynamically added notification only once', async () => {
  let currentNotification = null;
  let observerCallback;
  let disconnected = false;
  const root = {
    querySelector(selector) {
      return selector === '.card-notification' ? currentNotification : null;
    },
  };
  class FakeObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const controller = createAutoLootController({
    root,
    storage: memoryStorage(),
    Observer: FakeObserver,
    schedule: () => {},
  });
  await controller.initialize();
  await controller.setEnabled(true);

  let firstClicks = 0;
  currentNotification = { click: () => { firstClicks += 1; } };
  observerCallback();
  observerCallback();
  assert.equal(firstClicks, 1);

  let secondClicks = 0;
  currentNotification = { click: () => { secondClicks += 1; } };
  observerCallback();
  assert.equal(secondClicks, 1);

  await controller.setEnabled(false);
  assert.equal(disconnected, true);
});

test('club journal serializes writes, retains 500 events, survives reload and clears only itself', async () => {
  const storage = memoryStorage({ other: true });
  const journal = createClubBoostJournal({ storage, now: () => Date.parse('2026-09-07T18:00:00Z') });
  await Promise.all(Array.from({ length: 505 }, (_, attempt) => journal.record('attempt', { attempt })));
  const reloaded = createClubBoostJournal({ storage });
  const entries = await reloaded.getEntries();
  assert.equal(entries.length, 500);
  assert.equal(entries[0].attempt, 5);
  assert.equal(entries.at(-1).attempt, 504);
  assert.equal(entries[0].time, '2026-09-07T18:00:00.000Z');
  await reloaded.clear();
  assert.deepEqual(await reloaded.getEntries(), []);
  assert.equal(storage.values.other, true);
});

test('club journal storage failures do not prevent future records', async () => {
  const storage = memoryStorage();
  const originalSet = storage.set;
  let errors = 0;
  storage.set = async () => { throw new Error('storage unavailable'); };
  const journal = createClubBoostJournal({ storage, log: { error: () => { errors += 1; } } });
  await journal.record('failed write');
  storage.set = originalSet;
  await journal.record('recovered');
  assert.equal(errors, 1);
  assert.equal((await journal.getEntries())[0].event, 'recovered');
});

test('club boost reloads a stale closed page at 21:01 before S, then resumes once', async () => {
  let time = Date.parse('2026-09-07T18:00:59Z');
  let closed = true;
  let reloads = 0;
  let presses = 0;
  let card = 1;
  const timers = [];
  const events = [];
  const session = memoryStorage();
  const storage = memoryStorage({ 'animesssCardHelper.clubBoostEnabled': true });
  const deps = {
    storage, reloadStorage: session, now: () => time,
    root: { querySelector(selector) {
      if (selector.includes('progressbar')) return {
        getAttribute: (name) => name === 'aria-valuemax' || closed ? '600' : '599',
      };
      return { getAttribute: () => String(card) };
    } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {}, sleep: async (delay) => { time += delay; },
    reloadPage: () => { reloads += 1; },
    pressContributeKey: () => { presses += 1; card += 1; closed = true; },
    journal: { record: async (event) => { events.push(event); } },
    notify() {}, isBoostPage: () => true,
  };
  await createClubBoostController(deps).initialize();
  assert.equal(timers[0].delay, 1000);
  time += 1000;
  await timers.shift().callback();
  assert.equal(reloads, 1);
  assert.equal(presses, 0);
  assert.equal(session.values['animesssCardHelper.clubBoostReloadDate'], '2026-09-07');
  assert.ok(events.includes('Перезагрузка страницы перед авто-взносом'));
  closed = false;
  await createClubBoostController(deps).initialize();
  await timers.shift().callback();
  assert.equal(reloads, 1);
  assert.equal(presses, 1);
  assert.ok(timers[0].delay > 23 * 60 * 60 * 1000);
  // The next Moscow date requires another reload, even with stale 600/600.
  time = Date.parse('2026-09-08T18:01:00Z');
  await timers.shift().callback();
  assert.equal(reloads, 2);
  assert.equal(presses, 1);
});

test('club boost does not reload or press S after disabling the scheduled launch', async () => {
  let callback;
  let reloads = 0;
  const controller = createClubBoostController({
    root: { querySelector: () => null },
    storage: memoryStorage({ 'animesssCardHelper.clubBoostEnabled': true }),
    now: () => Date.parse('2026-09-07T18:01:00Z'),
    setTimeout: (fn) => { callback = fn; return 1; }, clearTimeout() {},
    reloadPage: () => { reloads += 1; }, isBoostPage: () => true,
    notify() {}, sleep: async () => {},
    pressContributeKey: () => assert.fail('must not press S'),
  });
  await controller.initialize();
  await controller.setEnabled(false);
  await callback();
  assert.equal(reloads, 0);
});

test('full progress after daily reload stops refresh and contribution until next day', async () => {
  let time = Date.parse('2026-09-07T18:01:01Z');
  let progress = 600;
  let refreshes = 0;
  let presses = 0;
  let id = 32610;
  const timers = [];
  const entries = [];
  const controller = createClubBoostController({
    now: () => time,
    storage: memoryStorage({ 'animesssCardHelper.clubBoostEnabled': true }),
    reloadStorage: memoryStorage({ 'animesssCardHelper.clubBoostReloadDate': '2026-09-07' }),
    reloadPage: () => assert.fail('already reloaded'),
    root: { querySelector(selector) {
      if (selector.includes('progressbar')) return {
        getAttribute: (name) => name === 'aria-valuenow' ? String(progress) : '600',
      };
      return { getAttribute: () => String(id) };
    } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {}, sleep: async (ms) => { time += ms; },
    refreshTask: () => { refreshes += 1; if (refreshes === 2) progress = 599; return true; },
    pressContributeKey: () => { assert.equal(progress, 599); presses += 1; progress = 600; id += 1; },
    journal: { record: (event, details) => entries.push({ event, ...details }) },
    notify() {}, isBoostPage: () => true,
  });
  await controller.initialize();
  await timers.shift().callback();
  assert.equal(presses, 0);
  assert.equal(refreshes, 0);
  assert.ok(timers[0].delay > 23 * 60 * 60 * 1000);
  const skipped = entries.find(e => e.event === 'Запуск пропущен');
  assert.equal(skipped.progressCurrent, '600');
  assert.equal(skipped.progressMaximum, '600');
  assert.equal(skipped.cardId, '32610');
  time = Date.parse('2026-09-07T19:30:00Z');
  await timers.shift().callback();
  assert.equal(refreshes, 0);
  assert.equal(presses, 0);
  assert.ok(timers[0].delay > 22 * 60 * 60 * 1000);
});

test('completed club day survives page reload even if page shows stale open progress', async () => {
  const timers=[];
  const controller=createClubBoostController({
    now:()=>Date.parse('2026-09-07T18:30:00Z'),
    storage:memoryStorage({'animesssCardHelper.clubBoostEnabled':true,
      'animesssCardHelper.clubBoostCompletedDate':'2026-09-07'}),
    root:{querySelector:()=>null},isBoostPage:()=>true,
    setTimeout:(fn,ms)=>{timers.push(ms);return 1;},clearTimeout(){},
    sleep:async()=>{},notify(){},pressContributeKey:()=>assert.fail('completed today'),
  });
  await controller.initialize();
  assert.equal(await controller.runNow(),false);
  assert.equal(timers[0],(23*60+31)*60000);
});

test('club tab schedules external enable and cancels external disable without writing settings', async () => {
  let time=Date.parse('2026-09-10T14:43:25Z');const timers=[],cancelled=[];
  const storage=memoryStorage({'animesssCardHelper.clubBoostEnabled':false});
  const controller=createClubBoostController({storage,root:{querySelector:()=>null},now:()=>time,
    setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;},
    clearTimeout:id=>cancelled.push(id),sleep:async()=>{},isBoostPage:()=>true,notify(){},
    pressContributeKey:()=>assert.fail('disabled scheduled run must not act')});
  await controller.initialize();assert.equal(timers.length,0);
  time=Date.parse('2026-09-10T15:00:30Z');
  controller.syncEnabled(true);
  assert.equal(timers[0].delay,Date.parse('2026-09-10T18:01:00Z')-time);
  controller.syncEnabled(true);assert.equal(timers.length,1);
  controller.syncEnabled(false);assert.deepEqual(cancelled,[1]);
  time=Date.parse('2026-09-10T18:01:00Z');await timers[0].callback();
  assert.equal(storage.values['animesssCardHelper.clubBoostEnabled'],false);
});

test('external setting during initialization wins over stale storage snapshot', async () => {
  let release;const timers=[];
  const controller=createClubBoostController({
    storage:{get:key=>key.includes('Enabled')?new Promise(resolve=>{release=()=>resolve({[key]:false});}):Promise.resolve({})},
    root:{querySelector:()=>null},now:()=>Date.parse('2026-09-10T18:10:00Z'),
    setTimeout:(fn,ms)=>{timers.push(ms);return 1;},clearTimeout(){},isBoostPage:()=>true,notify(){}});
  const pending=controller.initialize();controller.syncEnabled(true);release();
  assert.equal(await pending,true);assert.deepEqual(timers,[0]);
});

test('21:05 watchdog restarts a missed launch but does not repeat a completed day',async()=>{
  let time=Date.parse('2026-09-11T17:00:00Z'),presses=0,progress=599;
  const events=[];
  const controller=createClubBoostController({
    storage:memoryStorage({'animesssCardHelper.clubBoostEnabled':true}),
    root:{querySelector:selector=>selector.includes('progressbar')?{getAttribute:k=>k==='aria-valuenow'?String(progress):'600'}:null},
    now:()=>time,setTimeout:()=>1,clearTimeout(){},sleep:async()=>{},notify(){},isBoostPage:()=>true,
    pressContributeKey:()=>{presses++;progress=600;},journal:{record:(event,data)=>events.push({event,...data})}});
  await controller.initialize();
  await controller.checkScheduledRun();assert.equal(presses,0);
  time=Date.parse('2026-09-11T18:05:00Z');await controller.checkScheduledRun();
  assert.equal(presses,1);
  await controller.checkScheduledRun();assert.equal(presses,1);
  assert.equal(events.at(-1).retry,false);
});

test('initial 600 at 21:01 allows fresh reloads at 21:02 and 21:03 before starting',async()=>{
  let time=Date.parse('2026-09-13T18:01:02Z'),progress=600,reloads=0,presses=0;
  const storage=memoryStorage({'animesssCardHelper.clubBoostEnabled':true});
  const session=memoryStorage({'animesssCardHelper.clubBoostReloadDate':'2026-09-13'});
  const deps={storage,reloadStorage:session,reloadPage:()=>{reloads++;},
    now:()=>time,root:{querySelector:s=>s.includes('progressbar')?{getAttribute:k=>k==='aria-valuenow'?String(progress):'600'}:null},
    setTimeout:()=>1,clearTimeout(){},sleep:async()=>{},isBoostPage:()=>true,notify(){},
    pressContributeKey:()=>{presses++;progress=600;}};
  let controller=createClubBoostController(deps);await controller.initialize();await controller.runNow();
  assert.equal(storage.values['animesssCardHelper.clubBoostCompletedDate'],undefined);
  time=Date.parse('2026-09-13T18:02:00Z');await controller.checkScheduledRun(2);
  assert.equal(reloads,1);assert.equal(presses,0);
  controller=createClubBoostController(deps);await controller.initialize();await controller.runNow();
  await controller.checkScheduledRun(2);assert.equal(reloads,1);
  time=Date.parse('2026-09-13T18:03:00Z');await controller.checkScheduledRun(3);
  assert.equal(reloads,2);
  progress=599;controller=createClubBoostController(deps);await controller.initialize();await controller.runNow();
  assert.equal(presses,1);
  assert.equal(storage.values['animesssCardHelper.clubBoostCompletedDate'],'2026-09-13');
  await controller.checkScheduledRun(3);assert.equal(reloads,2);assert.equal(presses,1);
});

test('club boost waits until 21:01 Moscow when enabled before the target time', async () => {
  const timers = [];
  const controller = createClubBoostController({
    root: { querySelector: () => null },
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => Date.parse('2026-09-01T18:00:59Z'),
    setTimeout: (callback, delay) => {
      timers.push([callback, delay]);
      return timers.length;
    },
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });

  assert.equal(await controller.initialize(), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 1000);
});

test('club boost presses S more than 20 times and counts only changed cards', async () => {
  let currentTime = Date.parse('2026-09-01T18:01:00Z');
  let cardId = 100;
  let progressValue = 0;
  let keyPresses = 0;
  const delays = [];
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuenow'
            ? String(progressValue)
            : '21',
        };
      }
      if (selector.includes('data-card-id')) {
        return {
          getAttribute: () => String(cardId),
        };
      }
      return null;
    },
  };
  const controller = createClubBoostController({
    root,
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
      'animesssCardHelper.clubBoostDailyStateV2': {
        date: '2026-09-01',
        count: 20,
      },
    }),
    now: () => currentTime,
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async (delay) => {
      delays.push(delay);
      currentTime += delay;
    },
    pressContributeKey: () => {
      keyPresses += 1;
      cardId += 1;
      progressValue += 1;
    },
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), { contributed: 21 });
  assert.equal(keyPresses, 21);
  assert.deepEqual(delays, Array(21).fill(500));
});

test('club boost retries unchanged cards every 0.5 seconds until full', async () => {
  const events = [];
  let currentTime = Date.parse('2026-09-01T18:01:00Z');
  let progressValue = 0;
  let keyPresses = 0;
  const delays = [];
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuenow'
            ? String(progressValue)
            : '600',
        };
      }
      if (selector.includes('data-card-id')) {
        return { getAttribute: () => 'unchanged-card' };
      }
      return null;
    },
  };
  const controller = createClubBoostController({
    journal: { record: (event, details) => events.push({ event, ...details }) },
    root,
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => currentTime,
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async (delay) => {
      delays.push(delay);
      currentTime += delay;
      if (delays.length === 3) progressValue = 600;
    },
    pressContributeKey: () => { keyPresses += 1; },
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), { contributed: 0 });
  assert.equal(keyPresses, 3);
  assert.deepEqual(delays, [500,500,500]);
  assert.equal(events[3].cardId, 'unchanged-card');
  const stopped = events.find(e => e.event === 'Цикл остановлен');
  assert.equal(stopped.reason, 'клуб заполнен');
  assert.equal(stopped.attempts, 3);
  assert.equal(stopped.observedChanges, 0);
});

test('club boost schedules the next day when initialized after 22:30 Moscow', async () => {
  const timers = [];
  const controller = createClubBoostController({
    root: { querySelector: () => null },
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => Date.parse('2026-09-01T19:31:00Z'),
    setTimeout: (callback, delay) => {
      timers.push([callback, delay]);
      return timers.length;
    },
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });

  await controller.initialize();
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 81000000);
});

test('club boost stops before the next contribution when 22:30 Moscow arrives', async () => {
  let currentTime = Date.parse('2026-09-01T19:29:59.900Z');
  let keyPresses = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('data-card-id')) {
        return { getAttribute: () => 'same-card' };
      }
      return null;
    },
  };
  const controller = createClubBoostController({
    root,
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => currentTime,
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async (delay) => {
      currentTime += delay;
    },
    pressContributeKey: () => { keyPresses += 1; },
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), { contributed: 0 });
  assert.equal(keyPresses, 1);
});

test('club boost schedules a check but does not press S when the club progress is closed', async () => {
  const timers = [];
  let keyPresses = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuenow' ? '600' : '600',
        };
      }
      return null;
    },
  };
  const controller = createClubBoostController({
    root,
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => Date.parse('2026-09-01T18:01:00Z'),
    setTimeout: (callback, delay) => {
      timers.push([callback, delay]);
      return timers.length;
    },
    clearTimeout: () => {},
    sleep: async () => {},
    pressContributeKey: () => { keyPresses += 1; },
    notify: () => {},
    isBoostPage: () => true,
  });

  await controller.initialize();
  assert.equal(timers.length, 1);
  assert.equal(await controller.runNow(), false);
  assert.equal(keyPresses, 0);
});

test('club boost stops its active loop as soon as progress reaches its maximum', async () => {
  let currentProgress = 599;
  let cardId = 1;
  let keyPresses = 0;
  let scheduledTimers = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuenow'
            ? String(currentProgress)
            : '600',
        };
      }
      if (selector.includes('data-card-id')) {
        return { getAttribute: () => String(cardId) };
      }
      return null;
    },
  };
  const controller = createClubBoostController({
    root,
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => Date.parse('2026-09-01T18:01:00Z'),
    setTimeout: () => {
      scheduledTimers += 1;
      return scheduledTimers;
    },
    clearTimeout: () => {},
    sleep: async () => {},
    pressContributeKey: () => {
      keyPresses += 1;
      cardId += 1;
      currentProgress = 600;
    },
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), { contributed: 1 });
  assert.equal(keyPresses, 1);
  assert.equal(scheduledTimers, 2);
});

const CRYSTAL_MESSAGE =
  'Шпион демонической секты отобрал 300 мешков с камнями духа, помогите их собрать';

function chatItem({ text = CRYSTAL_MESSAGE, code = '4461-RH86' } = {}) {
  let clicks = 0;
  const crystal = code === null ? null : {
    getAttribute: (name) => name === 'data-code' ? code : null,
    click: () => { clicks += 1; },
  };
  return {
    querySelector(selector) {
      if (selector === '.animesss-chat__text') return { textContent: text };
      if (selector === '.diamond-chat[data-code]') return crystal;
      return null;
    },
    getClicks: () => clicks,
  };
}

function returnButton({ text = 'Я ВЕРНУЛСЯ', visible = true } = {}) {
  let clicks = 0;
  return {
    textContent: text,
    offsetParent: visible ? {} : null,
    click: () => { clicks += 1; },
    getClicks: () => clicks,
  };
}

function crystalFixture({
  initial = {},
  items = [],
  controls = [],
  storage = memoryStorage(initial),
} = {}) {
  const root = {
    querySelectorAll(selector) {
      if (selector === '.animesss-chat__item') return items;
      if (selector === 'button, [role="button"]') return controls;
      return [];
    },
  };
  const timers = [];
  const cleared = [];
  class Observer {
    constructor() {}
    observe() {}
    disconnect() {}
  }
  const controller = createChatCrystalController({
    root,
    storage,
    Observer,
    schedule: (callback) => callback(),
    setInterval: (callback, delay) => {
      timers.push({ callback, delay, id: timers.length + 1 });
      return timers.length;
    },
    clearInterval: (id) => cleared.push(id),
  });
  return { controller, storage, timers, cleared };
}

test('auto-crystal collects messages loaded asynchronously after resuming idle chat', async () => {
  const item = chatItem();
  let loaded = false;
  let resumed = false;
  const controller = createChatCrystalController({
    root: { querySelectorAll(selector) {
      if (selector === '.animesss-chat__item') return loaded ? [item] : [];
      return [{ textContent: 'Я вернулся', offsetParent: {}, click: () => { resumed = true; } }];
    } },
    storage: memoryStorage({ 'animesssCardHelper.autoCrystalEnabled': true }),
    setInterval: () => 1, clearInterval() {},
    sleep: async () => { assert.equal(resumed, true); loaded = true; },
  });
  await controller.initialize();
  assert.equal(item.getClicks(), 1);
});

test('auto-crystal stays disabled by default', async () => {
  const item = chatItem();
  const fixture = crystalFixture({ items: [item] });

  assert.equal(await fixture.controller.initialize(), false);
  assert.equal(item.getClicks(), 0);
});

test('auto-crystal clicks only an exact matching valid crystal', async () => {
  const exact = chatItem();
  const similar = chatItem({ text: `${CRYSTAL_MESSAGE}!`, code: 'other-1' });
  const missing = chatItem({ code: null });
  const unsafe = chatItem({ code: 'bad code!' });
  const fixture = crystalFixture({ items: [exact, similar, missing, unsafe] });
  await fixture.controller.initialize();

  assert.equal(await fixture.controller.setEnabled(true), true);
  assert.equal(exact.getClicks(), 1);
  assert.equal(similar.getClicks(), 0);
  assert.equal(unsafe.getClicks(), 0);
  assert.equal(
    fixture.storage.values['animesssCardHelper.autoCrystalEnabled'],
    true,
  );
});

test('auto-crystal clicks Я ВЕРНУЛСЯ and checks again every three minutes', async () => {
  const back = returnButton();
  const hidden = returnButton({ visible: false });
  const similar = returnButton({ text: 'Я ВЕРНУЛСЯ!' });
  const fixture = crystalFixture({ controls: [back, hidden, similar] });
  await fixture.controller.initialize();

  await fixture.controller.setEnabled(true);
  assert.equal(back.getClicks(), 1);
  assert.equal(hidden.getClicks(), 0);
  assert.equal(similar.getClicks(), 0);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, 180000);

  await fixture.timers[0].callback();
  assert.equal(back.getClicks(), 2);
});

test('auto-crystal never clicks the same data-code twice, including after reload', async () => {
  const first = chatItem();
  const fixture = crystalFixture({ items: [first] });
  await fixture.controller.initialize();
  await fixture.controller.setEnabled(true);
  await fixture.controller.scan();
  assert.equal(first.getClicks(), 1);

  const second = chatItem();
  const reloaded = crystalFixture({
    initial: fixture.storage.values,
    items: [second],
  });
  assert.equal(await reloaded.controller.initialize(), true);
  assert.equal(second.getClicks(), 0);
});

test('auto-crystal stops its three-minute checks when disabled', async () => {
  const back = returnButton();
  const fixture = crystalFixture({
    initial: { 'animesssCardHelper.autoCrystalEnabled': true },
    controls: [back],
  });
  await fixture.controller.initialize();
  assert.equal(fixture.timers.length, 1);
  assert.equal(back.getClicks(), 1);

  await fixture.controller.setEnabled(false);
  assert.deepEqual(fixture.cleared, [1]);

  await fixture.timers[0].callback();
  assert.equal(back.getClicks(), 1);
});

test('auto-crystal stops quietly when the extension context is invalidated', async () => {
  const items = [];
  const cleared = [];
  const storage = {
    async get(key) {
      if (key === 'animesssCardHelper.autoCrystalEnabled') {
        return { [key]: true };
      }
      return { [key]: [] };
    },
    async set() {
      throw new Error('Extension context invalidated.');
    },
  };
  const controller = createChatCrystalController({
    root: {
      querySelectorAll(selector) {
        return selector === '.animesss-chat__item' ? items : [];
      },
    },
    storage,
    setInterval: () => 9,
    clearInterval: (id) => cleared.push(id),
  });
  await controller.initialize();
  items.push(chatItem());

  await assert.doesNotReject(controller.runNow());
  assert.deepEqual(cleared, [9]);
});

function candidateCard({ id, ownerId, locked = false, visible = true } = {}) {
  return {
    offsetParent: visible ? {} : null,
    getAttribute(name) {
      if (name === 'data-owner-id') return ownerId || null;
      if (name === 'data-id') return id || null;
      return null;
    },
    classList: {
      contains(name) {
        return locked && (
          name === 'trade__inventory-item--lock' ||
          name === 'remelt__inventory-item--lock'
        );
      },
    },
  };
}

test('collectTradeCandidates keeps unique visible unlocked card instance IDs', () => {
  const first = candidateCard({ id: '17', ownerId: '101' });
  const duplicate = candidateCard({ id: '17', ownerId: '101' });
  const canonicalOnly = candidateCard({ id: '23' });
  const locked = candidateCard({ id: '31', ownerId: '103', locked: true });
  const hidden = candidateCard({ id: '41', ownerId: '104', visible: false });
  const doc = {
    querySelectorAll(selector) {
      assert.equal(selector, CARD_SELECTOR);
      return [first, duplicate, canonicalOnly, locked, hidden];
    },
  };

  assert.deepEqual(collectTradeCandidates(doc), [
    { element: first, id: '101' },
    { element: canonicalOnly, id: '23' },
  ]);
});

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

test('mass trade posts encoded IDs sequentially and accounts for added and deleted states', async () => {
  const requests = [];
  const responses = [
    { status: 'added' },
    { status: 'deleted' },
  ];
  const controller = createMassTradeController({
    fetch: async (url, options) => {
      requests.push([url, options]);
      return jsonResponse(responses.shift());
    },
    getUserHash: () => 'abc_123',
    sleep: async () => {},
    notify: () => {},
  });

  const result = await controller.start([{ id: '101' }, { id: '102' }]);

  assert.deepEqual(result, {
    added: 1,
    skipped: 1,
    failed: 0,
    stopped: false,
  });
  assert.equal(requests[0][0], '/index.php?controller=ajax&mod=trade_ajax');
  assert.equal(requests[0][1].credentials, 'same-origin');
  assert.equal(
    requests[0][1].body.toString(),
    'action=propose_add&type=1&card_id=101&user_hash=abc_123',
  );
  assert.equal(requests.length, 2);
});

test('mass trade retries a rate limit once and refuses a concurrent run', async () => {
  let resolveFirst;
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const controller = createMassTradeController({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return firstResponse;
      return jsonResponse({ status: 'added' });
    },
    getUserHash: () => 'abc_123',
    sleep: async () => {},
    notify: () => {},
  });

  const running = controller.start([{ id: '101' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await controller.start([{ id: '999' }]), null);
  resolveFirst(jsonResponse({
    error: 'Слишком часто, подождите пару секунд и повторите действие',
  }));

  assert.deepEqual(await running, {
    added: 1,
    skipped: 0,
    failed: 0,
    stopped: false,
  });
  assert.equal(calls, 2);
});

test('mass trade stop prevents the next request', async () => {
  let resolveFirst;
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const controller = createMassTradeController({
    fetch: async () => {
      calls += 1;
      return firstResponse;
    },
    getUserHash: () => 'abc_123',
    sleep: async () => {},
    notify: () => {},
  });

  const running = controller.start([{ id: '101' }, { id: '102' }]);
  await new Promise((resolve) => setImmediate(resolve));
  controller.stop();
  resolveFirst(jsonResponse({ status: 'added' }));

  assert.deepEqual(await running, {
    added: 1,
    skipped: 0,
    failed: 0,
    stopped: true,
  });
  assert.equal(calls, 1);
});
