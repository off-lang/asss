'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCardIds,
  detectEnlightenment,
  buildCardEndpoint,
  createController,
  findProfileUrl,
  extractCardUsers,
  createCardStatsRenderer,
  createAutoLootToggle,
  createChatCrystalToggle,
  createCardStatsToggle,
  createMassTradeAction,
  createStatsActions,
  createPersistentActivation,
  mountUi,
} = require('../content.js');

function fakeDoc(selectorMap) {
  return {
    querySelectorAll(selector) {
      return selectorMap[selector] || [];
    },
  };
}

function rewardItem(active) {
  return {
    textContent: 'Познать просветление',
    classList: { contains: (name) => active && name === 'reward-activated' },
  };
}

function parseFixtureHtml(html) {
  if (html === 'PROFILE_ACTIVE') {
    return fakeDoc({ '.shop__get-coins li': [rewardItem(true)] });
  }
  if (html === 'PROFILE_INACTIVE') {
    return fakeDoc({ '.shop__get-coins li': [rewardItem(false)] });
  }
  if (html.startsWith('CARDS:')) {
    const ids = html.slice(6).split(',').filter(Boolean);
    return fakeDoc({
      '.anime-cards__item[data-id]': ids.map((id) => ({
        getAttribute: () => id,
      })),
    });
  }
  if (html === 'OK') return ownersDocument([]);
  throw new Error(`Unknown HTML fixture: ${html}`);
}

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return body;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeDeps(overrides = {}) {
  const notices = [];
  const states = [];
  const errors = [];
  const defaults = {
    origin: 'https://animesss.com',
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      return response('CARDS:');
    },
    parseHtml: parseFixtureHtml,
    sleep: async () => {},
    setInterval: () => 101,
    clearInterval: () => {},
    findProfileUrl: () => 'https://animesss.com/profile',
    onState: (state) => states.push(state),
    notify: (kind, message) => notices.push([kind, message]),
    log: { error: (...args) => errors.push(args) },
  };
  return {
    ...defaults,
    notices,
    states,
    errors,
    ...overrides,
  };
}

function profileAnchor(href) {
  return { href };
}

function profileDocument({ preferred = [], all = [], scripts = [] }) {
  const container = {
    querySelectorAll(selector) {
      return selector === 'a[href*="/user/"]' ? preferred : [];
    },
  };
  return {
    querySelectorAll(selector) {
      if (selector === '[data-user-menu], .user-menu, .header__profile, .login-panel') {
        return preferred.length ? [container] : [];
      }
      if (selector === 'a[href*="/user/"]') return all;
      if (selector === 'script:not([src])') return scripts;
      return [];
    },
  };
}

function ownerLink(href, name, copies = '') {
  return {
    href,
    textContent: name,
    getAttribute(attribute) {
      if (attribute === 'data-count') return copies;
      return null;
    },
    querySelector(selector) {
      if (selector === '.card-show__owner-name') {
        return { textContent: name };
      }
      return null;
    },
  };
}

function ownersDocument(owners, displayedDuplicates = null) {
  return {
    querySelectorAll(selector) {
      if (selector === '.ncard__owners-list .card-show__owner') return owners;
      return [];
    },
    querySelector(selector) {
      if (
        selector === '[title="Дубли на руках"]' &&
        displayedDuplicates !== null
      ) {
        return { textContent: `Дубли ${displayedDuplicates}` };
      }
      return null;
    },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.hidden = false;
    this.listeners = {};
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  click() {
    return this.listeners.click && this.listeners.click();
  }

  querySelector(selector) {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.children.find((child) =>
      String(child.className).split(/\s+/).includes(className)
    ) || null;
  }
}

function collectText(element) {
  return [element.textContent, ...element.children.flatMap(collectText)]
    .filter(Boolean)
    .join(' ');
}

test('extractCardIds removes empty and duplicate IDs', () => {
  const cards = ['42', '', '42', '7'].map((id) => ({
    getAttribute: () => id,
  }));

  assert.deepEqual(
    extractCardIds(fakeDoc({ '.anime-cards__item[data-id]': cards })),
    ['42', '7'],
  );
});

test('detectEnlightenment requires matching text and activated class', () => {
  const active = {
    textContent: '  Познать   просветление  ',
    classList: { contains: (name) => name === 'reward-activated' },
  };
  assert.equal(
    detectEnlightenment(fakeDoc({ '.shop__get-coins li': [active] })),
    true,
  );

  const inactive = {
    ...active,
    classList: { contains: () => false },
  };
  assert.equal(
    detectEnlightenment(fakeDoc({ '.shop__get-coins li': [inactive] })),
    false,
  );
});

test('buildCardEndpoint encodes the card ID on the current origin', () => {
  assert.equal(
    buildCardEndpoint('https://animesss.com', '/cards/users/', '7 & 8'),
    'https://animesss.com/cards/users/?id=7+%26+8',
  );
});

test('start cannot create a second concurrent run', async () => {
  const pendingPage = deferred();
  let pageFetches = 0;
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      pageFetches += 1;
      return pendingPage.promise;
    },
  });
  const controller = createController(deps);

  const first = controller.start();
  await tick();
  const second = controller.start();
  await tick();

  assert.equal(pageFetches, 1);
  pendingPage.resolve(response('CARDS:'));
  await Promise.all([first, second]);
});

test('manual stop invalidates a pending run and clears the interval', async () => {
  const pendingPage = deferred();
  const cleared = [];
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      return pendingPage.promise;
    },
    clearInterval: (id) => cleared.push(id),
  });
  const controller = createController(deps);

  const run = controller.start();
  await tick();
  controller.stop('manual');
  pendingPage.resolve(response('CARDS:42'));
  await run;

  assert.equal(controller.getState().phase, 'idle');
  assert.deepEqual(cleared, [101]);
  assert.deepEqual(deps.notices.at(-1), ['info', 'Обработка остановлена.']);
});

test('empty page ends without a success notification', async () => {
  const deps = makeDeps();
  const controller = createController(deps);

  await controller.start();

  assert.equal(controller.getState().phase, 'idle');
  assert.equal(deps.notices.some(([kind]) => kind === 'success'), false);
  assert.deepEqual(deps.notices.at(-1), ['info', 'Карточки закончились.']);
});

test('an already completed profile makes no card requests', async () => {
  let cardRequests = 0;
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_ACTIVE');
      cardRequests += 1;
      return response('CARDS:');
    },
  });
  const controller = createController(deps);

  await controller.start();

  assert.equal(cardRequests, 0);
  assert.equal(controller.getState().phase, 'completed');
  assert.deepEqual(
    deps.notices.filter(([kind]) => kind === 'success'),
    [['success', 'Просветление получено!']],
  );
});

test('card endpoints are requested in order with the configured delays', async () => {
  const requested = [];
  const delays = [];
  let cardsPage = 0;
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      requested.push(url);
      if (url.includes('/cards/page/')) {
        cardsPage += 1;
        return response(cardsPage === 1 ? 'CARDS:42' : 'CARDS:');
      }
      return response('OK');
    },
    sleep: async (ms) => delays.push(ms),
  });
  const controller = createController(deps);

  await controller.start();

  assert.deepEqual(requested.slice(0, 4), [
    'https://animesss.com/cards/page/1/',
    'https://animesss.com/cards/users/?id=42',
    'https://animesss.com/cards/users/trade/?id=42',
    'https://animesss.com/cards/users/need/?id=42',
  ]);
  assert.equal(requested.at(-1), 'https://animesss.com/cards/page/2/');
  assert.deepEqual(delays, [600, 600, 600, 500]);
});

test('a failed card endpoint is logged and later endpoints continue', async () => {
  const requested = [];
  let cardsPage = 0;
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      requested.push(url);
      if (url.includes('/cards/page/')) {
        cardsPage += 1;
        return response(cardsPage === 1 ? 'CARDS:42' : 'CARDS:');
      }
      if (url.includes('/trade/')) throw new Error('offline');
      return response('OK');
    },
  });
  const controller = createController(deps);

  await controller.start();

  assert.ok(requested.some((url) => url.includes('/need/')));
  assert.equal(deps.errors.length, 1);
  assert.equal(deps.notices.some(([kind]) => kind === 'success'), false);
});

test('a transient network failure is retried before marking card data as failed', async () => {
  let cardsPage = 0;
  let tradeAttempts = 0;
  const updates = [];
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      if (url.includes('/cards/page/')) {
        cardsPage += 1;
        return response(cardsPage === 1 ? 'CARDS:2576' : 'CARDS:');
      }
      if (url.includes('/trade/')) {
        tradeAttempts += 1;
        if (tradeAttempts < 3) throw new TypeError('Failed to fetch');
      }
      return response('OK');
    },
    onCardData: (cardId, data) => updates.push([cardId, data]),
  });

  await createController(deps).start();

  assert.equal(tradeAttempts, 3);
  assert.equal(updates[0][0], '2576');
  assert.equal(updates[0][1].trade.status, 'ready');
  assert.equal(deps.errors.length, 0);
});

test('findProfileUrl prefers an account-menu profile link', () => {
  const doc = profileDocument({
    preferred: [profileAnchor('/user/current/')],
    all: [profileAnchor('/user/current/'), profileAnchor('/user/someone-else/')],
  });
  assert.equal(
    findProfileUrl(doc, 'https://animesss.com'),
    'https://animesss.com/user/current/',
  );
});

test('findProfileUrl accepts one unique same-origin fallback', () => {
  const doc = profileDocument({ all: [profileAnchor('/user/current/')] });
  assert.equal(
    findProfileUrl(doc, 'https://animesss.com'),
    'https://animesss.com/user/current/',
  );
});

test('findProfileUrl rejects cross-origin and ambiguous fallbacks', () => {
  const crossOrigin = profileDocument({
    all: [profileAnchor('https://example.com/user/current/')],
  });
  assert.equal(findProfileUrl(crossOrigin, 'https://animesss.com'), null);

  const ambiguous = profileDocument({
    all: [profileAnchor('/user/one/'), profileAnchor('/user/two/')],
  });
  assert.equal(findProfileUrl(ambiguous, 'https://animesss.com'), null);
});

test('findProfileUrl deduplicates links to the same profile', () => {
  const doc = profileDocument({
    all: [profileAnchor('/user/current/'), profileAnchor('/user/current/')],
  });
  assert.equal(
    findProfileUrl(doc, 'https://animesss.com'),
    'https://animesss.com/user/current/',
  );
});

test('findProfileUrl uses the logged-in visitor name from the page config', () => {
  const doc = profileDocument({
    all: [profileAnchor('/user/someone-else/'), profileAnchor('/user/another/')],
    scripts: [{ textContent: "var visitor_name = 'alex';" }],
  });

  assert.equal(
    findProfileUrl(doc, 'https://animesss.com'),
    'https://animesss.com/user/alex/',
  );
});

test('extractCardUsers returns safe unique users and duplicate count', () => {
  const doc = ownersDocument([
    ownerLink('/user/alice/', 'Alice', '3'),
    ownerLink('/user/bob/', 'Bob'),
    ownerLink('/user/alice/', 'Alice', '3'),
    ownerLink('/user/cards/?name=system', 'Служебная ссылка'),
    ownerLink('https://example.com/user/mallory/', 'Mallory'),
  ]);

  assert.deepEqual(extractCardUsers(doc, 'https://animesss.com'), {
    count: 2,
    duplicates: 2,
    users: [
      { name: 'Alice', url: 'https://animesss.com/user/alice/', copies: 3 },
      { name: 'Bob', url: 'https://animesss.com/user/bob/', copies: 1 },
    ],
  });
});

test('extractCardUsers prefers the displayed duplicate total', () => {
  const doc = ownersDocument(
    [ownerLink('/user/alice/', 'Alice'), ownerLink('/user/bob/', 'Bob')],
    9,
  );

  assert.equal(extractCardUsers(doc, 'https://animesss.com').duplicates, 9);
});

test('controller reports all three user lists for a processed card', async () => {
  const cardUpdates = [];
  let cardsPage = 0;
  const docs = {
    OWNERS: ownersDocument([ownerLink('/user/alice/', 'Alice', '2')]),
    TRADE: ownersDocument([ownerLink('/user/bob/', 'Bob')]),
    NEED: ownersDocument([
      ownerLink('/user/alice/', 'Alice'),
      ownerLink('/user/bob/', 'Bob'),
    ]),
  };
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.includes('/profile')) return response('PROFILE_INACTIVE');
      if (url.includes('/cards/page/')) {
        cardsPage += 1;
        return response(cardsPage === 1 ? 'CARDS:42' : 'CARDS:');
      }
      if (url.includes('/trade/')) return response('TRADE');
      if (url.includes('/need/')) return response('NEED');
      return response('OWNERS');
    },
    parseHtml: (html) => docs[html] || parseFixtureHtml(html),
    onCardData: (cardId, data) => cardUpdates.push([cardId, data]),
  });

  await createController(deps).start();

  assert.deepEqual(cardUpdates, [
    [
      '42',
      {
        owners: {
          status: 'ready',
          count: 1,
          duplicates: 1,
          users: [
            {
              name: 'Alice',
              url: 'https://animesss.com/user/alice/',
              copies: 2,
            },
          ],
        },
        trade: {
          status: 'ready',
          count: 1,
          duplicates: 0,
          users: [
            {
              name: 'Bob',
              url: 'https://animesss.com/user/bob/',
              copies: 1,
            },
          ],
        },
        need: {
          status: 'ready',
          count: 2,
          duplicates: 0,
          users: [
            {
              name: 'Alice',
              url: 'https://animesss.com/user/alice/',
              copies: 1,
            },
            {
              name: 'Bob',
              url: 'https://animesss.com/user/bob/',
              copies: 1,
            },
          ],
        },
      },
    ],
  ]);
});

test('card stats renderer keeps one compact block with no repeated categories', () => {
  const wrapper = new FakeElement('div');
  const card = new FakeElement('div');
  card.getAttribute = (name) => (name === 'data-id' ? '42' : null);
  card.closest = () => wrapper;
  const doc = {
    createElement: (tagName) => new FakeElement(tagName),
    querySelectorAll: (selector) =>
      selector === '.anime-cards__item[data-id]' ? [card] : [],
  };
  const render = createCardStatsRenderer(doc, 'https://animesss.com');
  const data = {
    owners: {
      status: 'ready',
      count: 1,
      duplicates: 2,
      users: [
        { name: 'Alice', url: 'https://animesss.com/user/alice/', copies: 3 },
      ],
    },
    trade: {
      status: 'ready',
      count: 1,
      duplicates: 0,
      users: [
        { name: 'Bob', url: 'https://animesss.com/user/bob/', copies: 1 },
      ],
    },
    need: { status: 'ready', count: 0, duplicates: 0, users: [] },
  };

  render('42', data);
  render('42', data);

  const blocks = wrapper.children.filter((child) =>
    child.className.includes('animesss-enlightenment-card-stats')
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].children.length, 1);
  const text = collectText(blocks[0]);
  assert.match(text, /Владельцы: 1.*Хотят: 0.*Обмен: 1.*Дубли: 2/);
  for (const label of ['Владельцы', 'Хотят', 'Обмен', 'Дубли']) {
    assert.equal(text.split(label).length - 1, 1);
  }
  assert.doesNotMatch(text, /Alice|Bob/);
});

test('card stats renderer accepts any card element and preserves valid metrics on partial error', () => {
  const wrapper = new FakeElement('div');
  const card = new FakeElement('div');
  card.className = 'deck__item';
  card.closest = () => wrapper;
  const doc = {
    createElement: (tagName) => new FakeElement(tagName),
    querySelectorAll: () => [],
  };
  const render = createCardStatsRenderer(doc, 'https://animesss.com');
  const data = {
    status: 'ready',
    ownersCount: 8,
    needCount: null,
    tradeCount: 3,
    duplicates: 1,
    users: { owners: [], need: [], trade: [] },
  };

  render(card, data);
  render(card, data);

  const blocks = wrapper.children.filter((child) =>
    child.className.includes('animesss-enlightenment-card-stats')
  );
  assert.equal(blocks.length, 1);
  assert.match(
    collectText(blocks[0]),
    /Владельцы: 8.*Хотят: —.*Обмен: 3.*Дубли: 1/,
  );
});

test('card stats renderer places accshop statistics beside the buy button', () => {
  const product = new FakeElement('div');
  product.id = 'shop-product';
  const buyButton = new FakeElement('button');
  buyButton.className = 'accshop__buy-btn';
  buyButton.parentElement = product;
  buyButton.closest = () => null;
  const doc = {
    createElement: (tagName) => new FakeElement(tagName),
    querySelectorAll: () => [],
  };
  const render = createCardStatsRenderer(doc, 'https://animesss.com');

  render(buyButton, {
    status: 'ready',
    ownersCount: 10,
    needCount: 2,
    tradeCount: 3,
    duplicates: 0,
    users: { owners: [], need: [], trade: [] },
  });

  assert.equal(product.children.length, 1);
  assert.match(collectText(product.children[0]), /Владельцы: 10.*Хотят: 2/);
  assert.equal(buyButton.children.length, 0);
});

test('auto-loot toggle initializes from persistence and updates pressed state', async () => {
  let clickHandler;
  const attributes = {};
  const button = {
    disabled: false,
    textContent: '',
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    addEventListener(name, handler) {
      if (name === 'click') clickHandler = handler;
    },
  };
  const writes = [];
  const controller = {
    async initialize() {
      return true;
    },
    async setEnabled(value) {
      writes.push(value);
      return value;
    },
  };
  const toggle = createAutoLootToggle({ button, controller, log: console });

  await toggle.initialize();
  assert.equal(attributes['aria-pressed'], 'true');
  assert.match(button.textContent, /включён/);

  await clickHandler();
  assert.deepEqual(writes, [false]);
  assert.equal(attributes['aria-pressed'], 'false');
  assert.match(button.textContent, /выключен/);
});

test('auto-crystal toggle initializes disabled and persists clicks', async () => {
  let clickHandler;
  const attributes = {};
  const button = {
    disabled: false,
    textContent: '',
    setAttribute(name, value) { attributes[name] = String(value); },
    addEventListener(name, handler) {
      if (name === 'click') clickHandler = handler;
    },
  };
  const writes = [];
  const toggle = createChatCrystalToggle({
    button,
    controller: {
      async initialize() { return false; },
      async setEnabled(value) { writes.push(value); return value; },
    },
    log: console,
  });

  await toggle.initialize();
  assert.equal(attributes['aria-pressed'], 'false');
  assert.match(button.textContent, /выключен/);
  await clickHandler();
  assert.deepEqual(writes, [true]);
  assert.equal(attributes['aria-pressed'], 'true');
  assert.match(button.textContent, /включён/);
});

test('card stats toggle defaults on, persists changes, and reloads cards when enabled', async () => {
  assert.equal(typeof createCardStatsToggle, 'function');
  if (typeof createCardStatsToggle !== 'function') return;
  let clickHandler;
  const attributes = {};
  const button = {
    disabled: false,
    textContent: '',
    setAttribute(name, value) { attributes[name] = String(value); },
    addEventListener(name, handler) {
      if (name === 'click') clickHandler = handler;
    },
  };
  const storage = {
    values: {},
    async get(key) { return { [key]: this.values[key] }; },
    async set(value) { Object.assign(this.values, value); },
  };
  const enabledStates = [];
  const visibility = [];
  let processes = 0;
  const toggle = createCardStatsToggle({
    button,
    storage,
    coordinator: {
      setEnabled: (value) => enabledStates.push(value),
      process: async () => { processes += 1; },
    },
    getCards: () => [{ id: '17' }],
    setVisible: (value) => visibility.push(value),
    log: console,
  });

  await toggle.initialize();
  assert.equal(attributes['aria-pressed'], 'true');
  assert.equal(processes, 1);

  await clickHandler();
  assert.equal(storage.values['animesssCardHelper.statsEnabled'], false);
  assert.equal(visibility.at(-1), false);

  await clickHandler();
  assert.equal(storage.values['animesssCardHelper.statsEnabled'], true);
  assert.equal(processes, 2);
  assert.deepEqual(enabledStates, [true, false, true]);
});

test('mass trade action requires confirmation and reports final counts', async () => {
  let clickHandler;
  const button = {
    disabled: false,
    textContent: '',
    addEventListener(name, handler) {
      if (name === 'click') clickHandler = handler;
    },
  };
  const confirmations = [false, true];
  const starts = [];
  const notices = [];
  const candidates = [{ id: '101' }, { id: '102' }];
  createMassTradeAction({
    button,
    collectCandidates: () => candidates,
    confirm: () => confirmations.shift(),
    controller: {
      async start(value) {
        starts.push(value);
        return { added: 1, skipped: 1, failed: 0, stopped: false };
      },
      stop() {},
    },
    notify: (kind, message) => notices.push([kind, message]),
    log: console,
  });

  await clickHandler();
  assert.equal(starts.length, 0);
  await clickHandler();
  assert.deepEqual(starts, [candidates]);
  assert.match(notices.at(-1)[1], /добавлено 1.*пропущено 1.*ошибок 0/);
});

test('mass trade action turns its running button into stop', async () => {
  let clickHandler;
  let finish;
  let stops = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const button = {
    disabled: false,
    textContent: '',
    addEventListener(name, handler) {
      if (name === 'click') clickHandler = handler;
    },
  };
  createMassTradeAction({
    button,
    collectCandidates: () => [{ id: '101' }, { id: '102' }],
    confirm: () => true,
    controller: {
      start: () => pending,
      stop: () => {
        stops += 1;
      },
    },
    notify: () => {},
    log: console,
  });

  const run = clickHandler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(button.textContent, /Остановить/);
  await clickHandler();
  assert.equal(stops, 1);
  finish({ added: 1, skipped: 0, failed: 0, stopped: true });
  await run;
  assert.match(button.textContent, /Массовый обмен/);
});

test('mountUi creates a collapsed accessible panel with all card actions', () => {
  const body = new FakeElement('body');
  const doc = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
  };

  const ui = mountUi(doc);

  assert.equal(ui.actions.hidden, true);
  assert.equal(ui.button.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(
    ui.actions.children.map((child) => child.getAttribute('aria-label')),
    [
      'Запустить проверку просветления',
      'Обновить спрос видимых карточек',
      'Переключить показ спроса карт',
      'Переключить авто-лут',
      'Переключить авто-кристалл',
      'Запустить массовый обмен',
      'Очистить кэш статистики',
    ],
  );

  ui.button.click();
  assert.equal(ui.actions.hidden, false);
  assert.equal(ui.button.getAttribute('aria-expanded'), 'true');
});

test('stats actions force-refresh visible cards and clear only the helper cache', async () => {
  let refreshClick;
  let clearClick;
  const refreshButton = {
    disabled: false,
    addEventListener: (_name, handler) => { refreshClick = handler; },
  };
  const clearButton = {
    disabled: false,
    addEventListener: (_name, handler) => { clearClick = handler; },
  };
  const cards = [{ id: 1 }, { id: 2 }];
  const processed = [];
  let clears = 0;
  const notices = [];
  createStatsActions({
    refreshButton,
    clearButton,
    getCards: () => cards,
    coordinator: {
      process: async (value, options) => processed.push([value, options]),
    },
    cache: { clear: async () => { clears += 1; } },
    notify: (kind, message) => notices.push([kind, message]),
    log: console,
  });

  await refreshClick();
  await clearClick();

  assert.deepEqual(processed, [[cards, { force: true }]]);
  assert.equal(clears, 1);
  assert.deepEqual(notices.map(([kind]) => kind), ['success', 'success']);
});

function activationFixture(savedEnabled) {
  let phase = 'idle';
  let starts = 0;
  let stops = 0;
  const writes = [];
  const controller = {
    getState: () => ({ phase }),
    async start() {
      starts += 1;
      phase = 'running';
    },
    stop() {
      stops += 1;
      phase = 'idle';
    },
  };
  const storage = {
    async get(key) {
      assert.equal(key, 'enabled');
      return { enabled: savedEnabled };
    },
    async set(value) {
      writes.push(value);
    },
  };
  const button = { disabled: false };
  const errors = [];
  const activation = createPersistentActivation({
    controller,
    storage,
    button,
    log: { error: (...args) => errors.push(args) },
  });
  return {
    activation,
    button,
    writes,
    errors,
    getStarts: () => starts,
    getStops: () => stops,
  };
}

test('saved enabled state automatically starts processing after reload', async () => {
  const fixture = activationFixture(true);

  assert.equal(fixture.button.disabled, true);
  await fixture.activation.initialize();

  assert.equal(fixture.getStarts(), 1);
  assert.equal(fixture.button.disabled, false);
  assert.deepEqual(fixture.writes, []);
});

test('manual start and stop persist the enabled state', async () => {
  const fixture = activationFixture(false);
  await fixture.activation.initialize();

  await fixture.activation.toggle();
  await fixture.activation.toggle();

  assert.equal(fixture.getStarts(), 1);
  assert.equal(fixture.getStops(), 1);
  assert.deepEqual(fixture.writes, [{ enabled: true }, { enabled: false }]);
});

test('completion disables future automatic starts', async () => {
  const fixture = activationFixture(true);
  await fixture.activation.initialize();

  await fixture.activation.disable();

  assert.deepEqual(fixture.writes, [{ enabled: false }]);
});

test('controller announces completion so persistence can be disabled', async () => {
  let completions = 0;
  const deps = makeDeps({
    fetch: async (url) =>
      url.includes('/profile')
        ? response('PROFILE_ACTIVE')
        : response('CARDS:'),
    onCompleted: () => {
      completions += 1;
    },
  });

  await createController(deps).start();

  assert.equal(completions, 1);
});
