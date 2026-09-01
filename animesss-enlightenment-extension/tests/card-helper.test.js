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

test('parseCardStats falls back to list size when counters are absent', () => {
  const doc = statsDocument({
    owners: [
      owner('https://animesss.com/user/a/', 'A'),
      owner('https://animesss.com/user/b/', 'B'),
    ],
  });

  const result = parseCardStats(doc, 'https://animesss.com');
  assert.equal(result.ownersCount, 2);
  assert.equal(result.needCount, 0);
  assert.equal(result.tradeCount, 0);
  assert.equal(result.duplicates, 0);
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

test('card stats client fetches missing need and trade lists without replacing main counters', async () => {
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
    'https://animesss.com/cards/users/need/?id=17',
    'https://animesss.com/cards/users/trade/?id=17',
  ]);
  assert.equal(result.ownersCount, 12);
  assert.equal(result.needCount, 7);
  assert.equal(result.tradeCount, 4);
  assert.deepEqual(result.users.need, [needUser]);
  assert.deepEqual(result.users.trade, [tradeUser]);
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
  assert.deepEqual(renders.map(([card]) => card), [regular, remelt]);
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

test('club boost waits until 21:00 Moscow when enabled before the target time', async () => {
  const timers = [];
  const controller = createClubBoostController({
    root: { querySelector: () => null },
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => Date.parse('2026-09-01T17:59:59Z'),
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

test('club boost refreshes and contributes no more than 20 cards in total', async () => {
  let refreshClicks = 0;
  let contributeClicks = 0;
  const delays = [];
  const progress = {
    getAttribute(name) {
      if (name === 'aria-valuenow') return '0';
      if (name === 'aria-valuemax') return '50';
      return null;
    },
  };
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) return progress;
      if (selector.includes('club__boost__refresh-btn')) {
        return { click: () => { refreshClicks += 1; } };
      }
      if (selector.includes('club__boost-btn')) {
        return { click: () => { contributeClicks += 1; } };
      }
      return null;
    },
  };
  const storage = memoryStorage({
    'animesssCardHelper.clubBoostEnabled': true,
  });
  const controller = createClubBoostController({
    root,
    storage,
    now: () => Date.parse('2026-09-01T18:00:00Z'),
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async (delay) => { delays.push(delay); },
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), {
    contributed: 20,
    limit: 20,
  });
  assert.equal(refreshClicks, 20);
  assert.equal(contributeClicks, 20);
  assert.deepEqual(delays.slice(0, 2), [300, 800]);
  assert.equal(delays.length, 40);
  assert.deepEqual(
    storage.values['animesssCardHelper.clubBoostDailyStateV2'],
    { date: '2026-09-01', count: 20 },
  );
});

test('club boost resumes the saved Moscow-day total after reload', async () => {
  let refreshClicks = 0;
  let contributeClicks = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuemax' ? '20' : '0',
        };
      }
      if (selector.includes('club__boost__refresh-btn')) {
        return { click: () => { refreshClicks += 1; } };
      }
      if (selector.includes('club__boost-btn')) {
        return { click: () => { contributeClicks += 1; } };
      }
      return null;
    },
  };
  const storage = memoryStorage({
    'animesssCardHelper.clubBoostEnabled': true,
    'animesssCardHelper.clubBoostDailyStateV2': {
      date: '2026-09-01',
      count: 19,
    },
  });
  const controller = createClubBoostController({
    root,
    storage,
    now: () => Date.parse('2026-09-01T18:00:00Z'),
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), {
    contributed: 20,
    limit: 20,
  });
  assert.equal(refreshClicks, 1);
  assert.equal(contributeClicks, 1);
});

test('club boost ignores lifetime site progress when enforcing the daily limit', async () => {
  let refreshClicks = 0;
  let contributeClicks = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuemax' ? '100' : '20',
        };
      }
      if (selector.includes('club__boost__refresh-btn')) {
        return { click: () => { refreshClicks += 1; } };
      }
      if (selector.includes('club__boost-btn')) {
        return { click: () => { contributeClicks += 1; } };
      }
      return null;
    },
  };
  const storage = memoryStorage({
    'animesssCardHelper.clubBoostEnabled': true,
    'animesssCardHelper.clubBoostDailyStateV2': {
      date: '2026-09-01',
      count: 0,
    },
  });
  const controller = createClubBoostController({
    root,
    storage,
    now: () => Date.parse('2026-09-01T18:00:00Z'),
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), {
    contributed: 20,
    limit: 20,
  });
  assert.equal(refreshClicks, 20);
  assert.equal(contributeClicks, 20);
});

test('club boost resets its own 20-card counter on a new Moscow date', async () => {
  let contributeClicks = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('club__boost__refresh-btn')) return { click() {} };
      if (selector.includes('club__boost-btn')) {
        return { click: () => { contributeClicks += 1; } };
      }
      return null;
    },
  };
  const storage = memoryStorage({
    'animesssCardHelper.clubBoostEnabled': true,
    'animesssCardHelper.clubBoostDailyStateV2': {
      date: '2026-08-31',
      count: 20,
    },
  });
  const controller = createClubBoostController({
    root,
    storage,
    now: () => Date.parse('2026-09-01T18:00:00Z'),
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();
  await controller.runNow();

  assert.equal(contributeClicks, 20);
  assert.deepEqual(
    storage.values['animesssCardHelper.clubBoostDailyStateV2'],
    { date: '2026-09-01', count: 20 },
  );
});

test('club boost ignores the legacy counter populated from lifetime progress', async () => {
  let contributeClicks = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('club__boost__refresh-btn')) return { click() {} };
      if (selector.includes('club__boost-btn')) {
        return { click: () => { contributeClicks += 1; } };
      }
      return null;
    },
  };
  const storage = memoryStorage({
    'animesssCardHelper.clubBoostEnabled': true,
    'animesssCardHelper.clubBoostState': {
      date: '2026-09-01',
      count: 20,
    },
  });
  const controller = createClubBoostController({
    root,
    storage,
    now: () => Date.parse('2026-09-01T18:00:00Z'),
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();
  await controller.runNow();

  assert.equal(contributeClicks, 20);
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
  assert.equal(timers[0][1], 80940000);
});

test('club boost stops before the next contribution when 22:30 Moscow arrives', async () => {
  let currentTime = Date.parse('2026-09-01T19:29:59.900Z');
  let refreshClicks = 0;
  let contributeClicks = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('club__boost__refresh-btn')) {
        return { click: () => { refreshClicks += 1; } };
      }
      if (selector.includes('club__boost-btn')) {
        return { click: () => { contributeClicks += 1; } };
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
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), {
    contributed: 0,
    limit: 20,
  });
  assert.equal(refreshClicks, 1);
  assert.equal(contributeClicks, 0);
});

test('club boost does not schedule or click when the club progress is closed', async () => {
  const timers = [];
  let clicks = 0;
  const root = {
    querySelector(selector) {
      if (selector.includes('progressbar')) {
        return {
          getAttribute: (name) => name === 'aria-valuenow' ? '600' : '600',
        };
      }
      return { click: () => { clicks += 1; } };
    },
  };
  const controller = createClubBoostController({
    root,
    storage: memoryStorage({
      'animesssCardHelper.clubBoostEnabled': true,
    }),
    now: () => Date.parse('2026-09-01T18:00:00Z'),
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
  assert.equal(timers.length, 0);
  assert.equal(await controller.runNow(), false);
  assert.equal(clicks, 0);
});

test('club boost stops its active loop as soon as progress reaches its maximum', async () => {
  let currentProgress = 599;
  let refreshClicks = 0;
  let contributeClicks = 0;
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
      if (selector.includes('club__boost__refresh-btn')) {
        return { click: () => { refreshClicks += 1; } };
      }
      if (selector.includes('club__boost-btn')) {
        return {
          click: () => {
            contributeClicks += 1;
            currentProgress = 600;
          },
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
    now: () => Date.parse('2026-09-01T18:00:00Z'),
    setTimeout: () => {
      scheduledTimers += 1;
      return scheduledTimers;
    },
    clearTimeout: () => {},
    sleep: async () => {},
    notify: () => {},
    isBoostPage: () => true,
  });
  await controller.initialize();

  assert.deepEqual(await controller.runNow(), {
    contributed: 1,
    limit: 20,
  });
  assert.equal(refreshClicks, 1);
  assert.equal(contributeClicks, 1);
  assert.equal(scheduledTimers, 1);
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
