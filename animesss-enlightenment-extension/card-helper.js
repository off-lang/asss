'use strict';

(function initializeCardHelper(root) {
  const CARD_CLASSES = [
    '.accshop__buy-btn[data-card-id]',
    '.remelt__inventory-item',
    '.lootbox__card',
    '.anime-cards__item',
    '.trade__inventory-item',
    '.trade__main-item',
    '.card-filter-list__card',
    '.deck__item',
    '.history__body-item',
    '.card-pack__card',
  ];
  const CARD_SELECTOR = CARD_CLASSES.join(', ');

  function numericId(value) {
    const normalized = String(value || '').trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  function hasClass(element, className) {
    if (!element) return false;
    if (element.classList && typeof element.classList.contains === 'function') {
      return element.classList.contains(className);
    }
    return String(element.className || '').split(/\s+/).includes(className);
  }

  function idFromHref(value) {
    const href = String(value || '');
    const queryMatch = href.match(/\/cards\/users\/?\?[^#]*\bid=(\d+)/);
    if (queryMatch) return queryMatch[1];
    const pathMatch = href.match(/\/cards\/(\d+)\/users\/?(?:[?#]|$)/);
    return pathMatch ? pathMatch[1] : null;
  }

  function getCanonicalCardId(element, lookupInstance = () => null) {
    if (!element || typeof element.getAttribute !== 'function') return null;

    if (hasClass(element, 'remelt__inventory-item')) {
      const instanceId = String(element.getAttribute('data-id') || '').trim();
      return numericId(lookupInstance(instanceId));
    }

    for (const attribute of ['data-card-id', 'card-id', 'data-id']) {
      const id = numericId(element.getAttribute(attribute));
      if (id) return id;
    }

    const directHref = element.getAttribute('href');
    const directId = idFromHref(directHref);
    if (directId) return directId;

    if (typeof element.querySelector === 'function') {
      const link = element.querySelector(
        'a[href*="/cards/users/?id="], a[href*="/cards/"][href*="/users/"]',
      );
      if (link && typeof link.getAttribute === 'function') {
        return idFromHref(link.getAttribute('href'));
      }
    }
    return null;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isExtensionContextInvalidated(error) {
    return String(error && error.message || error || '')
      .includes('Extension context invalidated');
  }

  function parseCounter(doc, selector, fallback) {
    const element = doc && typeof doc.querySelector === 'function'
      ? doc.querySelector(selector)
      : null;
    const match = normalizeText(element && element.textContent).match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : fallback;
  }

  function parseUsers(doc, origin) {
    const usersByUrl = new Map();
    const items = doc && typeof doc.querySelectorAll === 'function'
      ? doc.querySelectorAll('.ncard__owners-list .card-show__owner')
      : [];

    for (const item of items) {
      const link = item && item.href
        ? item
        : item && typeof item.querySelector === 'function'
          ? item.querySelector('a[href*="/user/"]')
          : null;
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
        url.search ||
        url.hash
      ) {
        continue;
      }

      const nameElement = typeof item.querySelector === 'function'
        ? item.querySelector('.card-show__owner-name')
        : null;
      const fallbackName = decodeURIComponent(
        url.pathname.replace(/^\/user\//, '').replace(/\/$/, ''),
      );
      const name = normalizeText(
        nameElement ? nameElement.textContent : link.textContent,
      ) || fallbackName;
      const rawCopies = typeof item.getAttribute === 'function'
        ? item.getAttribute('data-count') ||
          item.getAttribute('data-copies') ||
          item.getAttribute('data-dubl')
        : null;
      const copies = /^\d+$/.test(String(rawCopies || ''))
        ? Math.max(1, Number.parseInt(rawCopies, 10))
        : 1;
      const existing = usersByUrl.get(url.href);
      if (!existing || copies > existing.copies) {
        usersByUrl.set(url.href, { name, url: url.href, copies });
      }
    }
    return [...usersByUrl.values()];
  }

  function parseCardStats(doc, origin) {
    const owners = parseUsers(doc, origin);
    const calculatedDuplicates = owners.reduce(
      (sum, user) => sum + Math.max(0, user.copies - 1),
      0,
    );
    return {
      ownersCount: parseCounter(doc, '#owners-count', owners.length),
      needCount: parseCounter(doc, '#owners-need', 0),
      tradeCount: parseCounter(doc, '#owners-trade', 0),
      duplicates: parseCounter(
        doc,
        '[title="Дубли на руках"]',
        calculatedDuplicates,
      ),
      users: { owners, need: [], trade: [] },
    };
  }

  function createTtlCache({ storage, now = Date.now, prefix, ttlMs }) {
    function storageKey(key) {
      return `${prefix}${key}`;
    }

    async function get(key) {
      const fullKey = storageKey(key);
      const result = await storage.get(fullKey);
      const entry = result && result[fullKey];
      if (
        !entry ||
        typeof entry !== 'object' ||
        !Object.hasOwn(entry, 'value') ||
        !Number.isFinite(entry.expiresAt)
      ) {
        return null;
      }
      if (now() > entry.expiresAt) {
        await storage.remove(fullKey);
        return null;
      }
      return entry.value;
    }

    async function set(key, value) {
      const fullKey = storageKey(key);
      await storage.set({
        [fullKey]: { value, expiresAt: now() + ttlMs },
      });
    }

    async function remove(key) {
      await storage.remove(storageKey(key));
    }

    async function clear() {
      const all = typeof storage.getAll === 'function'
        ? await storage.getAll()
        : await storage.get(null);
      const keys = Object.keys(all || {}).filter((key) => key.startsWith(prefix));
      if (keys.length > 0) await storage.remove(keys);
    }

    return { get, set, delete: remove, clear };
  }

  function createCardStatsClient({
    origin,
    fetch,
    parseHtml,
    parseStats = parseCardStats,
    cache,
    sleep,
  }) {
    const inFlight = new Map();
    let requestTail = Promise.resolve();
    let hasRequested = false;

    function endpoint(path, cardId) {
      const url = new URL(path, origin);
      url.searchParams.set('id', cardId);
      return url.href;
    }

    function queuedFetch(url, shouldContinue) {
      const pending = requestTail.then(async () => {
        if (!shouldContinue()) throw new Error('Card stats request cancelled');
        if (hasRequested) await sleep(350);
        if (!shouldContinue()) throw new Error('Card stats request cancelled');
        hasRequested = true;
        return fetch(url);
      });
      requestTail = pending.catch(() => {});
      return pending;
    }

    function retryAfterMs(response) {
      const raw = response && response.headers &&
        typeof response.headers.get === 'function'
        ? response.headers.get('Retry-After')
        : null;
      const seconds = Number.parseInt(String(raw || ''), 10);
      return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
    }

    async function requestDocument(url, shouldContinue) {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await queuedFetch(url, shouldContinue);
          if (!response.ok) {
            const error = new Error(`HTTP ${response.status}: ${url}`);
            error.retryable = response.status === 429 || response.status >= 500;
            if (response.status === 429) {
              error.retryAfterMs = retryAfterMs(response);
            }
            throw error;
          }
          return parseHtml(await response.text());
        } catch (error) {
          lastError = error;
          const retryable = error instanceof TypeError || error.retryable === true;
          if (!retryable || attempt === 3) break;
          await sleep(error.retryAfterMs ?? attempt * 1000);
        }
      }
      throw lastError;
    }

    async function fetchStats(cardId, shouldContinue) {
      const mainDoc = await requestDocument(
        endpoint('/cards/users/', cardId),
        shouldContinue,
      );
      const stats = parseStats(mainDoc, origin);
      for (const [kind, path] of [
        ['need', '/cards/users/need/'],
        ['trade', '/cards/users/trade/'],
      ]) {
        if (!shouldContinue()) throw new Error('Card stats request cancelled');
        if (stats.users[kind].length > 0) continue;
        try {
          const listDoc = await requestDocument(
            endpoint(path, cardId),
            shouldContinue,
          );
          stats.users[kind] = parseStats(listDoc, origin).users.owners;
        } catch (_error) {
          stats.users[kind] = [];
        }
      }
      await cache.set(cardId, stats);
      return { status: 'ready', ...stats };
    }

    async function load(
      cardId,
      { force = false } = {},
      shouldContinue = () => true,
    ) {
      const normalizedId = numericId(cardId);
      if (!normalizedId) {
        return {
          status: 'error',
          ownersCount: null,
          needCount: null,
          tradeCount: null,
          duplicates: null,
          users: { owners: [], need: [], trade: [] },
        };
      }

      if (!force) {
        const cached = await cache.get(normalizedId);
        if (cached) return { status: 'ready', ...cached };
      }
      if (inFlight.has(normalizedId)) return inFlight.get(normalizedId);

      const pending = fetchStats(normalizedId, shouldContinue)
        .catch(() => ({
          status: 'error',
          ownersCount: null,
          needCount: null,
          tradeCount: null,
          duplicates: null,
          users: { owners: [], need: [], trade: [] },
        }))
        .finally(() => {
          inFlight.delete(normalizedId);
        });
      inFlight.set(normalizedId, pending);
      return pending;
    }

    return { load };
  }

  function createInstanceMap(cards) {
    const map = new Map();
    for (const card of cards || []) {
      if (!card || typeof card.getAttribute !== 'function') continue;
      const instanceId = String(card.getAttribute('data-owner-id') || '').trim();
      const canonicalId = numericId(card.getAttribute('data-id'));
      if (instanceId && canonicalId) map.set(instanceId, canonicalId);
    }
    return map;
  }

  function createInstanceMapStore({ storage, key }) {
    const values = new Map();

    async function initialize() {
      const result = await storage.get(key);
      const saved = result && result[key];
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
      for (const [instanceId, canonicalId] of Object.entries(saved)) {
        const validId = numericId(canonicalId);
        if (instanceId && validId) values.set(instanceId, validId);
      }
    }

    async function remember(cards) {
      let changed = false;
      for (const [instanceId, canonicalId] of createInstanceMap(cards)) {
        if (values.get(instanceId) === canonicalId) continue;
        values.set(instanceId, canonicalId);
        changed = true;
      }
      if (changed) await storage.set({ [key]: Object.fromEntries(values) });
    }

    return {
      initialize,
      remember,
      lookup: (instanceId) => values.get(instanceId) || null,
    };
  }

  function createCardStatsCoordinator({ client, instanceStore, render }) {
    let enabled = true;
    let generation = 0;

    async function process(cards, { force = false } = {}) {
      if (!enabled) return;
      const currentGeneration = generation;
      const uniqueCards = [...new Set(cards || [])];
      await instanceStore.remember(uniqueCards);
      for (const card of uniqueCards) {
        const shouldContinue = () =>
          enabled && generation === currentGeneration;
        if (!shouldContinue()) break;
        const cardId = getCanonicalCardId(card, instanceStore.lookup);
        if (!cardId) continue;
        const result = await client.load(cardId, { force }, shouldContinue);
        if (!shouldContinue()) break;
        render(card, result);
      }
    }

    function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return enabled;
      enabled = next;
      generation += 1;
      return enabled;
    }

    return { process, setEnabled, isEnabled: () => enabled };
  }

  function extractUserHash(doc) {
    const assignment = /\b(?:window\.)?dle_login_hash\s*=\s*'((?:\\.|[^'\\])*)'\s*;/;
    const scripts = doc && typeof doc.querySelectorAll === 'function'
      ? doc.querySelectorAll('script:not([src])')
      : [];
    for (const script of scripts) {
      const match = String(script.textContent || '').match(assignment);
      if (!match) continue;
      const value = match[1].replace(/\\(['"\\])/g, '$1');
      return /^[A-Za-z0-9_-]{6,128}$/.test(value) ? value : '';
    }
    return '';
  }

  function createAutoLootController({
    fetch,
    storage,
    getUserHash,
    now,
    setInterval,
    clearInterval,
    notify,
  }) {
    const enabledKey = 'animesssCardHelper.autoLootEnabled';
    const hourKey = 'animesssCardHelper.autoLootHour';
    let enabled = false;
    let timer = null;
    let inFlight = false;

    function startTimer() {
      if (!enabled || timer !== null) return;
      timer = setInterval(() => {
        void runNow();
      }, 190000);
    }

    function stopTimer() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    async function initialize() {
      const result = await storage.get(enabledKey);
      enabled = result && result[enabledKey] === true;
      startTimer();
      return enabled;
    }

    async function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return enabled;
      enabled = next;
      await storage.set({ [enabledKey]: enabled });
      if (enabled) startTimer();
      else stopTimer();
      return enabled;
    }

    async function runNow() {
      if (!enabled || inFlight) return false;
      inFlight = true;
      try {
        const hour = new Date(now()).toISOString().slice(0, 13);
        const saved = await storage.get(hourKey);
        if (saved && saved[hourKey] === hour) return false;

        const userHash = getUserHash();
        if (!userHash) {
          notify('error', 'Не удалось определить user_hash для авто-лута.');
          return false;
        }

        const response = await fetch('/ajax/card_for_watch/', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ user_hash: userHash }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let text = await response.text();
        if (text.startsWith('cards')) text = text.slice(5);
        const data = JSON.parse(text);
        if (
          String(data.if_reward || '').toLowerCase() === 'yes' &&
          Number.parseInt(data.reward_limit, 10) === 0
        ) {
          await storage.set({ [hourKey]: hour });
        }
        return true;
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          stop();
          return false;
        }
        notify('error', 'Ошибка автоматического сбора карточки.');
        return false;
      } finally {
        inFlight = false;
      }
    }

    function stop() {
      enabled = false;
      stopTimer();
    }

    return { initialize, setEnabled, runNow, stop };
  }

  function createChatCrystalController({
    root,
    storage,
    setInterval,
    clearInterval,
  }) {
    const targetMessage = normalizeText(
      'Шпион демонической секты отобрал 300 мешков с камнями духа, помогите их собрать',
    );
    const enabledKey = 'animesssCardHelper.autoCrystalEnabled';
    const codesKey = 'animesssCardHelper.crystalCodes';
    const maxSavedCodes = 100;
    let enabled = false;
    let timer = null;
    let inFlight = false;
    const processedCodes = new Set();

    function startTimer() {
      if (!enabled || timer !== null) return;
      timer = setInterval(() => {
        void runNow();
      }, 180000);
    }

    function stopTimer() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    async function saveProcessedCode(code) {
      processedCodes.add(code);
      const bounded = [...processedCodes].slice(-maxSavedCodes);
      if (bounded.length !== processedCodes.size) {
        processedCodes.clear();
        for (const savedCode of bounded) processedCodes.add(savedCode);
      }
      await storage.set({ [codesKey]: bounded });
    }

    async function scan() {
      if (!enabled) return 0;
      let clicked = 0;
      const items = root && typeof root.querySelectorAll === 'function'
        ? root.querySelectorAll('.animesss-chat__item')
        : [];

      for (const item of items) {
        if (!item || typeof item.querySelector !== 'function') continue;
        const text = item.querySelector('.animesss-chat__text');
        if (normalizeText(text && text.textContent) !== targetMessage) continue;

        const crystal = item.querySelector('.diamond-chat[data-code]');
        if (!crystal || typeof crystal.getAttribute !== 'function') continue;
        const code = normalizeText(crystal.getAttribute('data-code'));
        if (!/^[A-Za-z0-9_-]{4,128}$/.test(code)) continue;
        if (processedCodes.has(code) || typeof crystal.click !== 'function') continue;

        await saveProcessedCode(code);
        crystal.click();
        clicked += 1;
      }
      return clicked;
    }

    function findReturnButton() {
      const controls = root && typeof root.querySelectorAll === 'function'
        ? root.querySelectorAll('button, [role="button"]')
        : [];
      for (const control of controls) {
        const visible = control && (
          control.offsetParent !== null ||
          (typeof control.getClientRects === 'function' &&
            control.getClientRects().length > 0)
        );
        if (
          visible &&
          normalizeText(control.textContent).toUpperCase() === 'Я ВЕРНУЛСЯ' &&
          typeof control.click === 'function'
        ) {
          return control;
        }
      }
      return null;
    }

    async function runNow() {
      if (!enabled || inFlight) return false;
      inFlight = true;
      try {
        const returnButton = findReturnButton();
        if (returnButton) returnButton.click();
        await scan();
        return true;
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          stop();
          return false;
        }
        throw error;
      } finally {
        inFlight = false;
      }
    }

    function stop() {
      enabled = false;
      stopTimer();
    }

    async function initialize() {
      const [savedEnabled, savedCodes] = await Promise.all([
        storage.get(enabledKey),
        storage.get(codesKey),
      ]);
      enabled = savedEnabled && savedEnabled[enabledKey] === true;
      const codes = savedCodes && savedCodes[codesKey];
      if (Array.isArray(codes)) {
        for (const code of codes.slice(-maxSavedCodes)) {
          if (/^[A-Za-z0-9_-]{4,128}$/.test(String(code))) {
            processedCodes.add(String(code));
          }
        }
      }
      startTimer();
      if (enabled) await runNow();
      return enabled;
    }

    async function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return enabled;
      enabled = next;
      await storage.set({ [enabledKey]: enabled });
      if (enabled) {
        startTimer();
        await runNow();
      } else {
        stopTimer();
      }
      return enabled;
    }

    return {
      initialize,
      setEnabled,
      scan,
      runNow,
      stop,
    };
  }

  function collectTradeCandidates(doc) {
    const candidates = [];
    const seen = new Set();
    const cards = doc && typeof doc.querySelectorAll === 'function'
      ? doc.querySelectorAll(CARD_SELECTOR)
      : [];
    for (const card of cards) {
      if (!card || card.offsetParent === null) continue;
      if (
        card.classList && (
          card.classList.contains('trade__inventory-item--lock') ||
          card.classList.contains('remelt__inventory-item--lock')
        )
      ) {
        continue;
      }
      const id = numericId(
        card.getAttribute('data-owner-id') || card.getAttribute('data-id'),
      );
      if (!id || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ element: card, id });
    }
    return candidates;
  }

  function createMassTradeController({
    fetch,
    getUserHash,
    sleep,
    notify,
  }) {
    let running = false;
    let stopRequested = false;

    async function postCandidate(candidateId, userHash) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await fetch(
            '/index.php?controller=ajax&mod=trade_ajax',
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                action: 'propose_add',
                type: '1',
                card_id: candidateId,
                user_hash: userHash,
              }),
            },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (
            data &&
            data.error ===
              'Слишком часто, подождите пару секунд и повторите действие' &&
            attempt === 1
          ) {
            await sleep(2500);
            continue;
          }
          return data;
        } catch (_error) {
          return null;
        }
      }
      return null;
    }

    async function start(candidates) {
      if (running) return null;
      const userHash = getUserHash();
      if (!userHash) {
        notify('error', 'Не удалось определить user_hash для обмена.');
        return { added: 0, skipped: 0, failed: 0, stopped: false };
      }

      running = true;
      stopRequested = false;
      const result = { added: 0, skipped: 0, failed: 0, stopped: false };
      try {
        for (let index = 0; index < candidates.length; index += 1) {
          if (stopRequested) break;
          const data = await postCandidate(candidates[index].id, userHash);
          if (data && data.status === 'added') result.added += 1;
          else if (data && data.status === 'deleted') result.skipped += 1;
          else result.failed += 1;
          notify(
            'info',
            `Обмен: обработано ${index + 1}/${candidates.length}`,
          );
          if (index < candidates.length - 1 && !stopRequested) {
            await sleep(1800);
          }
        }
        result.stopped = stopRequested;
        return result;
      } finally {
        running = false;
      }
    }

    function stop() {
      if (running) stopRequested = true;
    }

    function getState() {
      return { running, stopRequested };
    }

    return { start, stop, getState };
  }

  function createCardObserver({
    root,
    selector,
    schedule,
    onCards,
    Observer,
  }) {
    const pending = new Set();
    let flushScheduled = false;

    function flush() {
      flushScheduled = false;
      const cards = [...pending];
      pending.clear();
      if (cards.length > 0) onCards(cards);
    }

    function queue(card) {
      if (!card) return;
      pending.add(card);
      if (flushScheduled) return;
      flushScheduled = true;
      schedule(flush);
    }

    function collect(node) {
      if (!node || node.nodeType !== 1) return;
      if (typeof node.matches === 'function' && node.matches(selector)) queue(node);
      if (typeof node.querySelectorAll === 'function') {
        for (const card of node.querySelectorAll(selector)) queue(card);
      }
    }

    const observer = new Observer((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes || []) collect(node);
        } else if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'data-id' &&
          mutation.target &&
          typeof mutation.target.matches === 'function' &&
          mutation.target.matches(selector)
        ) {
          queue(mutation.target);
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-id', 'data-card-id', 'card-id'],
    });

    function scan() {
      const cards = [...root.querySelectorAll(selector)];
      if (cards.length > 0) onCards(cards);
    }

    return { scan, disconnect: () => observer.disconnect() };
  }

  const api = {
    CARD_SELECTOR,
    collectTradeCandidates,
    createAutoLootController,
    createChatCrystalController,
    createCardObserver,
    createCardStatsCoordinator,
    createCardStatsClient,
    createInstanceMap,
    createInstanceMapStore,
    createMassTradeController,
    createTtlCache,
    extractUserHash,
    getCanonicalCardId,
    parseCardStats,
  };
  root.AnimesssCardHelper = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : window);
