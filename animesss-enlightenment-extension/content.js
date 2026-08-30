'use strict';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractCardIds(doc) {
  const values = Array.from(
    doc.querySelectorAll('.anime-cards__item[data-id]'),
  )
    .map((card) => normalizeText(card.getAttribute('data-id')))
    .filter(Boolean);

  return [...new Set(values)];
}

function detectEnlightenment(doc) {
  return Array.from(doc.querySelectorAll('.shop__get-coins li')).some(
    (item) =>
      normalizeText(item.textContent).includes('Познать просветление') &&
      item.classList.contains('reward-activated'),
  );
}

function buildCardEndpoint(origin, path, cardId) {
  const url = new URL(path, origin);
  url.searchParams.set('id', cardId);
  return url.href;
}

function extractVisitorName(doc) {
  const assignment = /\b(?:var|let|const)?\s*visitor_name\s*=\s*'((?:\\.|[^'\\])*)'\s*;/;
  for (const script of doc.querySelectorAll('script:not([src])')) {
    const match = String(script.textContent || '').match(assignment);
    if (match) {
      return normalizeText(match[1].replace(/\\(['"\\])/g, '$1'));
    }
  }
  return '';
}

function extractCardUsers(doc, origin) {
  const usersByUrl = new Map();
  const items = doc.querySelectorAll(
    '.ncard__owners-list .card-show__owner',
  );

  for (const item of items) {
    const link = item.href
      ? item
      : item.querySelector('a[href*="/user/"]');
    if (!link) continue;

    let url;
    try {
      url = new URL(link.href, origin);
    } catch (_error) {
      continue;
    }

    if (
      url.origin !== origin ||
      !/^\/user\/[^/]+\/?$/.test(url.pathname) ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      continue;
    }

    const nameElement = item.querySelector('.card-show__owner-name');
    const fallbackName = decodeURIComponent(
      url.pathname.replace(/^\/user\//, '').replace(/\/$/, ''),
    );
    const name = normalizeText(
      nameElement ? nameElement.textContent : link.textContent,
    ) || fallbackName;

    const countElement = item.querySelector('.card-show__owner-count');
    const countText = normalizeText(
      countElement ? countElement.textContent : item.textContent,
    );
    const explicitCount = [
      item.getAttribute('data-count'),
      item.getAttribute('data-copies'),
      item.getAttribute('data-dubl'),
    ].find((value) => /^\d+$/.test(String(value || '')));
    const textCount = countText.match(/(?:[×x]\s*|дубл(?:ей|я|ь)?\s*:?\s*)(\d+)/i);
    const copies = Math.max(
      1,
      Number.parseInt(explicitCount || (textCount && textCount[1]) || '1', 10),
    );

    const existing = usersByUrl.get(url.href);
    if (!existing || copies > existing.copies) {
      usersByUrl.set(url.href, { name, url: url.href, copies });
    }
  }

  const users = [...usersByUrl.values()];
  let duplicates = users.reduce(
    (total, user) => total + Math.max(0, user.copies - 1),
    0,
  );

  const displayedDuplicates = typeof doc.querySelector === 'function'
    ? doc.querySelector('[title="Дубли на руках"]')
    : null;
  if (displayedDuplicates) {
    const match = normalizeText(displayedDuplicates.textContent).match(/\d+/);
    if (match) duplicates = Number.parseInt(match[0], 10);
  }

  return { count: users.length, duplicates, users };
}

function findProfileUrl(doc, origin) {
  function uniqueProfileUrls(anchors) {
    const urls = new Set();
    for (const anchor of anchors) {
      try {
        const url = new URL(anchor.href, origin);
        if (url.origin === origin && url.pathname.includes('/user/')) {
          urls.add(url.href);
        }
      } catch (_error) {
        // Ignore malformed links from page markup.
      }
    }
    return [...urls];
  }

  const visitorName = extractVisitorName(doc);
  if (visitorName) {
    return new URL(`/user/${encodeURIComponent(visitorName)}/`, origin).href;
  }

  const preferredAnchors = [];
  const preferredContainers = doc.querySelectorAll(
    '[data-user-menu], .user-menu, .header__profile, .login-panel',
  );
  for (const container of preferredContainers) {
    preferredAnchors.push(...container.querySelectorAll('a[href*="/user/"]'));
  }

  const preferredUrls = uniqueProfileUrls(preferredAnchors);
  if (preferredUrls.length === 1) return preferredUrls[0];
  if (preferredUrls.length > 1) return null;

  const fallbackUrls = uniqueProfileUrls(
    doc.querySelectorAll('a[href*="/user/"]'),
  );
  return fallbackUrls.length === 1 ? fallbackUrls[0] : null;
}

function createController(deps) {
  let phase = 'idle';
  let page = 1;
  let runId = 0;
  let checkTimer = null;
  let checkInFlight = false;

  function getState() {
    return { phase, page, runId };
  }

  function emitState() {
    deps.onState(getState());
  }

  function clearCheckTimer() {
    if (checkTimer !== null) {
      deps.clearInterval(checkTimer);
      checkTimer = null;
    }
  }

  function isCurrent(id) {
    return runId === id && phase === 'running';
  }

  function settleIdle(kind, message) {
    runId += 1;
    clearCheckTimer();
    phase = 'idle';
    emitState();
    if (message) deps.notify(kind, message);
  }

  function complete() {
    if (phase === 'completed') return;
    runId += 1;
    clearCheckTimer();
    phase = 'completed';
    emitState();
    deps.notify('success', 'Просветление получено!');
    if (typeof deps.onCompleted === 'function') deps.onCompleted();
  }

  async function fetchDocument(url, label) {
    const response = await deps.fetch(url);
    if (!response.ok) {
      throw new Error(`${label}: HTTP ${response.status}`);
    }
    return deps.parseHtml(await response.text());
  }

  async function checkReward(profileUrl, id) {
    if (checkInFlight || !isCurrent(id)) return false;
    checkInFlight = true;
    try {
      const profileDoc = await fetchDocument(
        profileUrl,
        'Не удалось проверить профиль',
      );
      if (!isCurrent(id)) return false;
      if (detectEnlightenment(profileDoc)) {
        complete();
        return true;
      }
      return false;
    } catch (error) {
      if (isCurrent(id)) {
        deps.log.error('Ошибка проверки просветления:', error);
        deps.notify('error', 'Не удалось проверить просветление.');
      }
      return false;
    } finally {
      checkInFlight = false;
    }
  }

  async function requestCardEndpoint(url, id) {
    if (!isCurrent(id)) return null;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await deps.fetch(url);
        if (!response.ok) {
          const httpError = new Error(`HTTP ${response.status}: ${url}`);
          httpError.retryable = response.status === 429 || response.status >= 500;
          throw httpError;
        }
        const result = extractCardUsers(
          deps.parseHtml(await response.text()),
          deps.origin,
        );
        return { status: 'ready', ...result };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof TypeError || error.retryable === true;
        if (!retryable || attempt === 3 || !isCurrent(id)) break;
        await deps.sleep(attempt * 1000);
        if (!isCurrent(id)) return null;
      }
    }

    deps.log.error(`Ошибка запроса ${url}:`, lastError);
    return {
      status: 'error',
      count: null,
      duplicates: null,
      users: [],
    };
  }

  async function processPages(id) {
    while (isCurrent(id)) {
      const pageUrl = new URL(`/cards/page/${page}/`, deps.origin).href;
      try {
        const pageResponse = await deps.fetch(pageUrl);
        if (!isCurrent(id)) return;
        if (!pageResponse.ok) {
          throw new Error(`HTTP ${pageResponse.status}: ${pageUrl}`);
        }

        const pageDoc = deps.parseHtml(await pageResponse.text());
        if (!isCurrent(id)) return;
        const cardIds = extractCardIds(pageDoc);
        if (cardIds.length === 0) {
          settleIdle('info', 'Карточки закончились.');
          return;
        }

        for (const cardId of cardIds) {
          const endpointDefinitions = [
            ['owners', '/cards/users/'],
            ['trade', '/cards/users/trade/'],
            ['need', '/cards/users/need/'],
          ];
          const cardData = {};
          for (const [kind, path] of endpointDefinitions) {
            if (!isCurrent(id)) return;
            cardData[kind] = await requestCardEndpoint(
              buildCardEndpoint(deps.origin, path, cardId),
              id,
            );
            if (!isCurrent(id)) return;
            await deps.sleep(600);
          }
          if (typeof deps.onCardData === 'function') {
            deps.onCardData(cardId, cardData);
          }
        }

        if (!isCurrent(id)) return;
        page += 1;
        emitState();
        await deps.sleep(500);
      } catch (error) {
        if (isCurrent(id)) {
          deps.log.error(`Ошибка при обработке страницы ${pageUrl}:`, error);
          settleIdle('error', 'Ошибка загрузки страницы карточек.');
        }
        return;
      }
    }
  }

  async function start() {
    if (phase !== 'idle') return;

    phase = 'starting';
    page = 1;
    runId += 1;
    const id = runId;
    emitState();

    const profileUrl = deps.findProfileUrl();
    if (!profileUrl) {
      phase = 'idle';
      emitState();
      deps.notify('error', 'Не удалось однозначно определить ваш профиль.');
      return;
    }

    try {
      const profileDoc = await fetchDocument(
        profileUrl,
        'Не удалось загрузить профиль',
      );
      if (runId !== id || phase !== 'starting') return;
      if (detectEnlightenment(profileDoc)) {
        complete();
        return;
      }

      phase = 'running';
      emitState();
      checkTimer = deps.setInterval(() => {
        void checkReward(profileUrl, id);
      }, 30000);
      deps.notify('info', 'Обработка запущена.');
      await processPages(id);
    } catch (error) {
      if (runId === id && phase === 'starting') {
        deps.log.error('Ошибка запуска:', error);
        settleIdle('error', 'Не удалось проверить профиль.');
      }
    }
  }

  function stop(reason = 'manual') {
    if (phase !== 'starting' && phase !== 'running') return;
    runId += 1;
    clearCheckTimer();
    phase = 'idle';
    emitState();
    if (reason === 'manual') {
      deps.notify('info', 'Обработка остановлена.');
    }
  }

  emitState();

  return { start, stop, getState };
}

function createCardStatsRenderer(doc, origin) {
  const categories = [
    ['owners', 'Владельцы'],
    ['need', 'Хотят'],
    ['trade', 'Обмен'],
  ];

  function metric(label, value) {
    const item = doc.createElement('span');
    item.className = 'animesss-enlightenment-card-metric';
    item.textContent = `${label}: ${value === null || value === undefined ? '—' : value}`;
    return item;
  }

  function normalizedCategoryData(data) {
    if (data && data.owners && data.need && data.trade) return data;
    const status = data && data.status === 'ready' ? 'ready' : 'error';
    const users = data && data.users ? data.users : {};
    return {
      owners: {
        status,
        count: data ? data.ownersCount : null,
        duplicates: data ? data.duplicates : null,
        users: users.owners || [],
      },
      need: {
        status,
        count: data ? data.needCount : null,
        duplicates: 0,
        users: users.need || [],
      },
      trade: {
        status,
        count: data ? data.tradeCount : null,
        duplicates: 0,
        users: users.trade || [],
      },
    };
  }

  return function renderCardStats(cardOrId, rawData) {
    const directCard = cardOrId && typeof cardOrId === 'object'
      ? cardOrId
      : null;
    const cardId = directCard ? null : String(cardOrId);
    const cards = directCard
      ? [directCard]
      : doc.querySelectorAll('.anime-cards__item[data-id]');
    const data = normalizedCategoryData(rawData);
    for (const card of cards) {
      if (cardId !== null && card.getAttribute('data-id') !== cardId) continue;
      const isAccshopButton = String(card.className || '')
        .split(/\s+/)
        .includes('accshop__buy-btn');
      const shopProduct = isAccshopButton
        ? card.closest('#accshopCardsWrap > *') || card.parentElement
        : null;
      const wrapper = shopProduct ||
        card.closest('.anime-cards__item-wrapper') ||
        card;
      let block = wrapper.querySelector('.animesss-enlightenment-card-stats');
      if (!block) {
        block = doc.createElement('section');
        block.className =
          'animesss-enlightenment-card-stats animesss-card-helper-stats';
        block.setAttribute('aria-label', 'Статистика карточки');
        wrapper.append(block);
      }

      const metrics = doc.createElement('div');
      metrics.className = 'animesss-enlightenment-card-metrics';
      for (const [kind, label] of categories) {
        const result = data[kind];
        metrics.append(metric(
          label,
          result && result.status === 'ready' ? result.count : '—',
        ));
      }
      const owners = data.owners;
      metrics.append(metric(
        'Дубли',
        owners && owners.status === 'ready' ? owners.duplicates : '—',
      ));

      block.replaceChildren(metrics);
    }
  };
}

function createPersistentActivation({ controller, storage, button, log }) {
  let ready = false;
  let busy = false;
  button.disabled = true;

  function startWithoutBlocking() {
    Promise.resolve(controller.start()).catch((error) => {
      log.error('Ошибка автоматического запуска:', error);
    });
  }

  async function persist(enabled) {
    try {
      await storage.set({ enabled });
    } catch (error) {
      log.error('Не удалось сохранить состояние расширения:', error);
    }
  }

  async function initialize() {
    try {
      const saved = await storage.get('enabled');
      if (saved.enabled === true) startWithoutBlocking();
    } catch (error) {
      log.error('Не удалось прочитать состояние расширения:', error);
    } finally {
      ready = true;
      button.disabled = false;
    }
  }

  async function toggle() {
    if (!ready || busy) return;
    busy = true;
    try {
      const { phase } = controller.getState();
      if (phase === 'starting' || phase === 'running') {
        await persist(false);
        controller.stop('manual');
      } else if (phase === 'idle') {
        await persist(true);
        startWithoutBlocking();
      }
    } finally {
      busy = false;
    }
  }

  async function disable() {
    await persist(false);
  }

  return { initialize, toggle, disable };
}

function createAutoLootToggle({ button, controller, log }) {
  let enabled = false;
  let busy = false;

  function render() {
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = `Авто-лут: ${enabled ? 'включён' : 'выключен'}`;
  }

  async function initialize() {
    button.disabled = true;
    try {
      enabled = await controller.initialize();
    } catch (error) {
      log.error('Не удалось инициализировать авто-лут:', error);
    } finally {
      button.disabled = false;
      render();
    }
  }

  async function toggle() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      enabled = await controller.setEnabled(!enabled);
    } catch (error) {
      log.error('Не удалось изменить авто-лут:', error);
    } finally {
      busy = false;
      button.disabled = false;
      render();
    }
  }

  button.addEventListener('click', toggle);
  render();
  return { initialize, toggle };
}

function createChatCrystalToggle({ button, controller, log }) {
  let enabled = false;
  let busy = false;

  function render() {
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = `Авто-кристалл: ${enabled ? 'включён' : 'выключен'}`;
  }

  async function initialize() {
    button.disabled = true;
    try {
      enabled = await controller.initialize();
    } catch (error) {
      log.error('Не удалось инициализировать авто-кристалл:', error);
    } finally {
      button.disabled = false;
      render();
    }
  }

  async function toggle() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      enabled = await controller.setEnabled(!enabled);
    } catch (error) {
      log.error('Не удалось изменить авто-кристалл:', error);
    } finally {
      busy = false;
      button.disabled = false;
      render();
    }
  }

  button.addEventListener('click', toggle);
  render();
  return { initialize, toggle };
}

function createCardStatsToggle({
  button,
  storage,
  coordinator,
  getCards,
  setVisible,
  log,
}) {
  const storageKey = 'animesssCardHelper.statsEnabled';
  let enabled = true;
  let busy = false;

  function render() {
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = `Спрос карт: ${enabled ? 'включён' : 'выключен'}`;
  }

  async function apply(value, loadCards) {
    enabled = value === true;
    coordinator.setEnabled(enabled);
    setVisible(enabled);
    render();
    if (enabled && loadCards) await coordinator.process(getCards());
    return enabled;
  }

  async function initialize() {
    button.disabled = true;
    try {
      const saved = await storage.get(storageKey);
      await apply(!saved || saved[storageKey] !== false, true);
    } catch (error) {
      log.error('Не удалось инициализировать показ спроса:', error);
    } finally {
      button.disabled = false;
      render();
    }
    return enabled;
  }

  async function toggle() {
    if (busy) return enabled;
    busy = true;
    button.disabled = true;
    try {
      const next = !enabled;
      await storage.set({ [storageKey]: next });
      return await apply(next, next);
    } catch (error) {
      log.error('Не удалось изменить показ спроса:', error);
      return enabled;
    } finally {
      busy = false;
      button.disabled = false;
      render();
    }
  }

  button.addEventListener('click', toggle);
  render();
  return { initialize, toggle };
}

function createMassTradeAction({
  button,
  collectCandidates,
  confirm,
  controller,
  notify,
  log,
}) {
  let running = false;

  function render() {
    button.textContent = running
      ? 'Остановить массовый обмен'
      : 'Массовый обмен';
  }

  async function handle() {
    if (running) {
      controller.stop();
      button.textContent = 'Останавливаем…';
      return;
    }
    const candidates = collectCandidates();
    if (candidates.length === 0) {
      notify('info', 'Доступные карты для обмена не найдены.');
      return;
    }
    if (!confirm(`Отметить для обмена ${candidates.length} карт?`)) return;

    running = true;
    render();
    try {
      const result = await controller.start(candidates);
      if (!result) return;
      notify(
        result.failed > 0 ? 'error' : 'success',
        `Обмен завершён: добавлено ${result.added}, ` +
          `пропущено ${result.skipped}, ошибок ${result.failed}.`,
      );
    } catch (error) {
      log.error('Ошибка массового обмена:', error);
      notify('error', 'Не удалось завершить массовый обмен.');
    } finally {
      running = false;
      render();
    }
  }

  button.addEventListener('click', handle);
  render();
  return { handle };
}

function createStatsActions({
  refreshButton,
  clearButton,
  getCards,
  coordinator,
  cache,
  notify,
  log,
}) {
  async function refresh() {
    refreshButton.disabled = true;
    try {
      const cards = getCards();
      await coordinator.process(cards, { force: true });
      notify('success', `Спрос обновлён для ${cards.length} карточек.`);
    } catch (error) {
      log.error('Ошибка обновления спроса:', error);
      notify('error', 'Не удалось обновить спрос карточек.');
    } finally {
      refreshButton.disabled = false;
    }
  }

  async function clear() {
    clearButton.disabled = true;
    try {
      await cache.clear();
      notify('success', 'Кэш статистики очищен.');
    } catch (error) {
      log.error('Ошибка очистки кэша:', error);
      notify('error', 'Не удалось очистить кэш статистики.');
    } finally {
      clearButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', refresh);
  clearButton.addEventListener('click', clear);
  return { refresh, clear };
}

function mountUi(doc) {
  const button = doc.createElement('button');
  button.id = 'animesss-enlightenment-control';
  button.type = 'button';
  button.textContent = '☰';
  button.setAttribute('aria-label', 'Открыть инструменты карточек');
  button.setAttribute('aria-expanded', 'false');

  const notifications = doc.createElement('div');
  notifications.id = 'animesss-enlightenment-notifications';
  notifications.setAttribute('aria-live', 'polite');
  notifications.setAttribute('aria-atomic', 'false');

  const actions = doc.createElement('div');
  actions.id = 'animesss-card-helper-actions';
  actions.setAttribute('aria-label', 'Инструменты карточек');
  actions.hidden = true;

  const enlightenmentButton = doc.createElement('button');
  enlightenmentButton.type = 'button';
  enlightenmentButton.className = 'animesss-card-helper-action';
  enlightenmentButton.setAttribute(
    'aria-label',
    'Запустить проверку просветления',
  );
  enlightenmentButton.setAttribute('aria-pressed', 'false');

  const refreshButton = doc.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'animesss-card-helper-action';
  refreshButton.textContent = 'Обновить спрос';
  refreshButton.setAttribute(
    'aria-label',
    'Обновить спрос видимых карточек',
  );

  const statsToggleButton = doc.createElement('button');
  statsToggleButton.type = 'button';
  statsToggleButton.className = 'animesss-card-helper-action';
  statsToggleButton.setAttribute('aria-label', 'Переключить показ спроса карт');

  const autoLootButton = doc.createElement('button');
  autoLootButton.type = 'button';
  autoLootButton.className = 'animesss-card-helper-action';
  autoLootButton.setAttribute('aria-label', 'Переключить авто-лут');

  const autoCrystalButton = doc.createElement('button');
  autoCrystalButton.type = 'button';
  autoCrystalButton.className = 'animesss-card-helper-action';
  autoCrystalButton.setAttribute('aria-label', 'Переключить авто-кристалл');

  const tradeButton = doc.createElement('button');
  tradeButton.type = 'button';
  tradeButton.className = 'animesss-card-helper-action';
  tradeButton.setAttribute('aria-label', 'Запустить массовый обмен');

  const clearCacheButton = doc.createElement('button');
  clearCacheButton.type = 'button';
  clearCacheButton.className = 'animesss-card-helper-action';
  clearCacheButton.textContent = 'Очистить кэш';
  clearCacheButton.setAttribute('aria-label', 'Очистить кэш статистики');

  actions.append(
    enlightenmentButton,
    refreshButton,
    statsToggleButton,
    autoLootButton,
    autoCrystalButton,
    tradeButton,
    clearCacheButton,
  );

  doc.body.append(button, actions, notifications);

  button.addEventListener('click', () => {
    actions.hidden = !actions.hidden;
    button.setAttribute('aria-expanded', String(!actions.hidden));
    button.setAttribute(
      'aria-label',
      actions.hidden
        ? 'Открыть инструменты карточек'
        : 'Закрыть инструменты карточек',
    );
  });

  function setState(phase) {
    enlightenmentButton.classList.remove(
      'is-starting',
      'is-running',
      'is-completed',
    );
    enlightenmentButton.disabled = false;
    enlightenmentButton.setAttribute('aria-pressed', 'false');

    if (phase === 'starting') {
      enlightenmentButton.classList.add('is-starting');
      enlightenmentButton.textContent = 'Просветление: запуск…';
      enlightenmentButton.setAttribute('aria-pressed', 'true');
      enlightenmentButton.setAttribute('aria-label', 'Остановить запуск обработки');
    } else if (phase === 'running') {
      enlightenmentButton.classList.add('is-running');
      enlightenmentButton.textContent = 'Остановить просветление';
      enlightenmentButton.setAttribute('aria-pressed', 'true');
      enlightenmentButton.setAttribute('aria-label', 'Остановить обработку просветления');
    } else if (phase === 'completed') {
      enlightenmentButton.classList.add('is-completed');
      enlightenmentButton.textContent = 'Просветление получено ✓';
      enlightenmentButton.disabled = true;
      enlightenmentButton.setAttribute('aria-label', 'Просветление получено');
    } else {
      enlightenmentButton.textContent = 'Запустить просветление';
      enlightenmentButton.setAttribute(
        'aria-label',
        'Запустить проверку просветления',
      );
    }
  }

  function notify(kind, message) {
    const item = doc.createElement('div');
    item.className = `animesss-enlightenment-notice is-${kind}`;
    item.textContent = message;
    notifications.append(item);
    setTimeout(() => item.remove(), 5000);
  }

  return {
    button,
    enlightenmentButton,
    refreshButton,
    statsToggleButton,
    autoLootButton,
    autoCrystalButton,
    tradeButton,
    clearCacheButton,
    actions,
    setState,
    notify,
  };
}

function mountExtension() {
  if (
    !document.body ||
    document.getElementById('animesss-enlightenment-control')
  ) {
    return;
  }

  const ui = mountUi(document);
  const origin = window.location.origin;
  const renderCardStats = createCardStatsRenderer(document, origin);
  const cardHelper = globalThis.AnimesssCardHelper;
  let activation = null;
  const controller = createController({
    origin,
    fetch: window.fetch.bind(window),
    parseHtml: (html) =>
      new DOMParser().parseFromString(html, 'text/html'),
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    findProfileUrl: () => findProfileUrl(document, origin),
    onState: ({ phase }) => ui.setState(phase),
    notify: ui.notify,
    log: window.console,
    onCardData: renderCardStats,
    onCompleted: () => {
      if (activation) void activation.disable();
    },
  });

  activation = createPersistentActivation({
    controller,
    storage: chrome.storage.local,
    button: ui.enlightenmentButton,
    log: window.console,
  });

  ui.enlightenmentButton.addEventListener('click', () => {
    void activation.toggle();
  });
  void activation.initialize();

  if (cardHelper) {
    const statsCache = cardHelper.createTtlCache({
      storage: chrome.storage.local,
      now: Date.now,
      prefix: 'animesssCardHelper.stats.',
      ttlMs: 24 * 60 * 60 * 1000,
    });
    const instanceStore = cardHelper.createInstanceMapStore({
      storage: chrome.storage.local,
      key: 'animesssCardHelper.instances',
    });
    const statsClient = cardHelper.createCardStatsClient({
      origin,
      fetch: window.fetch.bind(window),
      parseHtml: (html) =>
        new DOMParser().parseFromString(html, 'text/html'),
      cache: statsCache,
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    });
    const coordinator = cardHelper.createCardStatsCoordinator({
      client: statsClient,
      instanceStore,
      render: renderCardStats,
    });
    coordinator.setEnabled(false);
    const getStatsCards = () => [
      ...document.querySelectorAll(cardHelper.CARD_SELECTOR),
    ];
    const statsToggle = createCardStatsToggle({
      button: ui.statsToggleButton,
      storage: chrome.storage.local,
      coordinator,
      getCards: getStatsCards,
      setVisible: (enabled) => {
        document.body.classList.toggle(
          'animesss-card-stats-disabled',
          !enabled,
        );
        ui.refreshButton.disabled = !enabled;
      },
      log: window.console,
    });
    const autoLootController = cardHelper.createAutoLootController({
      fetch: window.fetch.bind(window),
      storage: chrome.storage.local,
      getUserHash: () => cardHelper.extractUserHash(document),
      now: Date.now,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      notify: ui.notify,
    });
    const autoLootToggle = createAutoLootToggle({
      button: ui.autoLootButton,
      controller: autoLootController,
      log: window.console,
    });
    void autoLootToggle.initialize();
    const chatCrystalController = cardHelper.createChatCrystalController({
      root: document.body,
      storage: chrome.storage.local,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
    });
    const chatCrystalToggle = createChatCrystalToggle({
      button: ui.autoCrystalButton,
      controller: chatCrystalController,
      log: window.console,
    });
    void chatCrystalToggle.initialize();
    const massTradeController = cardHelper.createMassTradeController({
      fetch: window.fetch.bind(window),
      getUserHash: () => cardHelper.extractUserHash(document),
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      notify: ui.notify,
    });
    createMassTradeAction({
      button: ui.tradeButton,
      collectCandidates: () => cardHelper.collectTradeCandidates(document),
      confirm: window.confirm.bind(window),
      controller: massTradeController,
      notify: ui.notify,
      log: window.console,
    });
    createStatsActions({
      refreshButton: ui.refreshButton,
      clearButton: ui.clearCacheButton,
      getCards: getStatsCards,
      coordinator,
      cache: statsCache,
      notify: ui.notify,
      log: window.console,
    });

    void instanceStore.initialize().then(async () => {
      const observer = cardHelper.createCardObserver({
        root: document.body,
        selector: cardHelper.CARD_SELECTOR,
        schedule: (callback) => window.setTimeout(callback, 0),
        onCards: (cards) => {
          void coordinator.process(cards).catch((error) => {
            window.console.error('Ошибка статистики карточек:', error);
          });
        },
        Observer: window.MutationObserver,
      });
      await statsToggle.initialize();
    }).catch((error) => {
      window.console.error('Не удалось запустить Card Helper:', error);
    });
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    extractCardIds,
    detectEnlightenment,
    buildCardEndpoint,
    createController,
    findProfileUrl,
    mountUi,
    extractVisitorName,
    extractCardUsers,
    createCardStatsRenderer,
    createAutoLootToggle,
    createChatCrystalToggle,
    createCardStatsToggle,
    createMassTradeAction,
    createStatsActions,
    createPersistentActivation,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountExtension();
}
