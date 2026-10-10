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
  const NATIVE_STATS_SELECTOR = '.card-stats, .labyrinth-card-stats, .accshop-card-stats';
  const HELPER_STATS_SELECTOR = '.animesss-enlightenment-card-stats';

  function cardStatsWrapper(card) {
    if(hasClass(card,'accshop__buy-btn'))return card.closest?.('.accshop__card') || card.closest?.('#accshopCardsWrap > *') || card.parentElement || card;
    return card.closest?.('.anime-cards__item-wrapper') || card;
  }

  function hasNativeCardStats(card) {
    const wrapper=cardStatsWrapper(card);
    function visible(el) {
      for(let node=el;node;node=node.parentElement) {
        if(node.hidden || node.getAttribute?.('aria-hidden')==='true')return false;
        const style=node.ownerDocument?.defaultView?.getComputedStyle(node);
        if(style && (style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse'))return false;
        if(node===wrapper)break;
      }
      return true;
    }
    return [...(wrapper.querySelectorAll?.(NATIVE_STATS_SELECTOR) || [])].some(block=>{
      if(block.closest?.(HELPER_STATS_SELECTOR) || !visible(block))return false;
      // A paid feature can be absent, hidden, or still loading. Require real counters,
      // including zero; do not treat a placeholder or a global subscription flag as data.
      return ['Владельцев','Хотят получить','Готовы обменять'].every(label=>
        [...block.querySelectorAll('[title], [aria-label]')].some(metric=>{
          if(!visible(metric))return false;
          const caption=metric.getAttribute('aria-label') || metric.getAttribute('title') || '';
          if(caption!==label && !caption.startsWith(label+':'))return false;
          const value=caption.includes(':')?caption.slice(caption.indexOf(':')+1):metric.textContent;
          return /^\d+$/.test(value.replace(/[\s\u00a0\u202f]/g,''));
        }));
    });
  }

  function suppressNativeDuplicate(card) {
    if(!hasNativeCardStats(card))return false;
    for(const block of cardStatsWrapper(card).querySelectorAll?.(HELPER_STATS_SELECTOR) || [])block.remove();
    return true;
  }

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

    const isTrade = hasClass(element,'trade__inventory-item') || hasClass(element,'trade__main-item');
    for (const attribute of (isTrade ? ['data-original-id','data-card-id','card-id'] : ['data-card-id', 'card-id', 'data-id'])) {
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
    return isTrade ? numericId(lookupInstance(element.getAttribute('data-id'))) : null;
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
    return {
      ownersCount: parseCounter(doc, '#owners-count', owners.length || null),
      needCount: parseCounter(doc, '#owners-need', null),
      tradeCount: parseCounter(doc, '#owners-trade', null),
      duplicates: parseCounter(
        doc,
        '[title="Дубли на руках"]',
        null,
      ),
      users: { owners, need: [], trade: [] },
    };
  }

  function parsePersonalCopies(doc, origin, name) {
    const heading = doc.querySelector('h1.ncard__main-title');
    const profile = heading?.querySelector('a[href]');
    if (!profile) return null;
    try {
      const url = new URL(profile.getAttribute('href'), origin);
      if (url.origin !== origin || decodeURIComponent(url.pathname) !== `/user/${name}/`) return null;
    } catch (_) { return null; }
    const match = normalizeText(heading.querySelector('span')?.textContent).match(/^\(([\d\s]+) шт\.\)$/);
    const total = match ? Number(match[1].replace(/\s/g, '')) : NaN;
    return Number.isSafeInteger(total) && total >= 0 ? total : null;
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
    collectionName = '',
    collectionRank = '',
    instanceStore,
  }) {
    const inFlight = new Map();
    let requestTail = Promise.resolve();
    let hasRequested = false;
    let requestRate = 3;
    const requestDelays = new Map([
      [1, 1000],
      [3, 350],
      [5, 200],
    ]);

    function setRequestRate(value) {
      const normalized = Number(value);
      if (requestDelays.has(normalized)) requestRate = normalized;
      return requestRate;
    }

    function endpoint(path, cardId) {
      const url = new URL(path, origin);
      url.searchParams.set('id', cardId);
      return url.href;
    }

    function queuedFetch(url, shouldContinue) {
      const pending = requestTail.then(async () => {
        if (!shouldContinue()) throw new Error('Card stats request cancelled');
        if (hasRequested) await sleep(requestDelays.get(requestRate));
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

    async function fetchStats(cardId, shouldContinue, onProgress) {
      const mainDoc = await requestDocument(
        endpoint('/cards/users/', cardId),
        shouldContinue,
      );
      const stats = parseStats(mainDoc, origin);
      if ([stats.ownersCount,stats.needCount,stats.tradeCount].every(value=>value==null)) throw new Error('Статистика карты отсутствует');
      // The site's "Дубли на руках" is this visitor's total copies, not
      // duplicate holdings summed across a (possibly paginated) owners list.
      if (stats.duplicates == null && collectionName) {
        if (shouldContinue()) onProgress({ status: 'ready', ...stats });
        const url = new URL('/user/cards/', origin);
        url.searchParams.set('name', collectionName);
        url.searchParams.set('card_id', cardId);
        try {
          stats.duplicates = parsePersonalCopies(await requestDocument(url.href, shouldContinue), origin, collectionName);
        } catch (_) { stats.duplicates = null; }
      }
      await cache.set(cardId, stats);
      return { status: 'ready', ...stats };
    }

    async function load(
      cardId,
      { force = false } = {},
      shouldContinue = () => true,
      onProgress = () => {},
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

      const pending = fetchStats(normalizedId, shouldContinue, onProgress)
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

    const collectionScans = new Map();
    const resolvedInstances = new Map();
    async function resolveInstance(instanceId, shouldContinue = () => true, rank = collectionRank) {
      const id = numericId(instanceId);
      if (!id || !collectionName || !/^[a-z_]+$/.test(rank)) return null;
      const lookup = () => instanceStore?.lookup(id) || resolvedInstances.get(id) || null;
      if (lookup()) return lookup();
      // Own-instance trade pages reject self-trades. Read the collection instead,
      // preserving all mappings from each page and sharing one scan per rank.
      if (!collectionScans.has(rank)) collectionScans.set(rank, { page: 1, done: false, pending: null });
      const state = collectionScans.get(rank);
      while (shouldContinue() && !lookup() && !state.done) {
        if (!state.pending) {
          state.pending = (async () => {
            const url = new URL('/user/cards/', origin);
            url.searchParams.set('name', collectionName);
            url.searchParams.set('rank', rank);
            url.searchParams.set('page', String(state.page));
            const doc = await requestDocument(url.href, shouldContinue);
            if (!shouldContinue()) return;
            const cards = [...doc.querySelectorAll('.anime-cards__item[data-owner-id][data-id]')];
            if (!cards.length) throw new Error('Не удалось прочитать коллекцию карт');
            for (const [instance, canonical] of createInstanceMap(cards)) resolvedInstances.set(instance, canonical);
            await instanceStore?.remember(cards);
            const hasNext = [...doc.querySelectorAll('a[href]')].some(link => {
              try {
                const next = new URL(link.getAttribute('href'), origin);
                return next.origin === origin && next.pathname === '/user/cards/' &&
                  next.searchParams.get('name') === collectionName &&
                  next.searchParams.get('rank') === rank &&
                  Number(next.searchParams.get('page')) === state.page + 1;
              } catch { return false; }
            });
            state.done = !hasNext || state.page >= 200;
            state.page += 1;
          })().finally(() => { state.pending = null; });
        }
        await state.pending;
      }
      return lookup();
    }
    return { load, resolveInstance, setRequestRate, getRequestRate: () => requestRate };
  }

  function createInstanceMap(cards) {
    const map = new Map();
    for (const card of cards || []) {
      if (!card || typeof card.getAttribute !== 'function') continue;
      const trade = hasClass(card, 'trade__inventory-item') || hasClass(card, 'trade__main-item');
      const instanceId = String(card.getAttribute(trade ? 'data-id' : 'data-owner-id') || '').trim();
      const canonicalId = trade ? getCanonicalCardId(card) : numericId(card.getAttribute('data-id'));
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
      async rememberPair(instanceId, canonicalId) {
        if (!numericId(instanceId) || !numericId(canonicalId)) return;
        values.set(String(instanceId),String(canonicalId));
        await storage.set({[key]:Object.fromEntries(values)});
      },
    };
  }

  function createCardStatsCoordinator({ client, instanceStore, render }) {
    let enabled = true;
    let generation = 0;
    const retained = new Map();
    function identity(card) {
      const keys=[];
      const id=getCanonicalCardId(card,instanceStore.lookup);
      if(id)keys.push('card:'+id);
      const trade=hasClass(card,'trade__inventory-item')||hasClass(card,'trade__main-item');
      const instance=card.getAttribute(trade?'data-id':'data-owner-id');
      if(instance)keys.push('instance:'+instance);
      const image=card.querySelector?.('img[src], img[data-src]');
      const src=image?.getAttribute('data-src')||image?.getAttribute('src');
      if(src && /\/cards_image\//.test(src)) {
        try {keys.push('image:'+new URL(src,'https://animesss.com').pathname);}catch{}
      }
      return keys;
    }
    function previous(keys) {for(const key of keys)if(retained.has(key))return retained.get(key);return null;}
    function remember(keys,entry) {
      for(const key of keys)retained.set(key,entry);
      while(retained.size>3000)retained.delete(retained.keys().next().value);
    }

    async function process(cards, { force = false } = {}) {
      if (!enabled) return;
      const currentGeneration = generation;
      const uniqueCards = [...new Set(cards || [])];
      // Restore every known card before waiting for any network request.
      const restored=new Set();
      for(const card of uniqueCards){
        if(suppressNativeDuplicate(card))continue;
        const keys=identity(card),saved=previous(keys);
        if(saved){render(card,saved.result);remember(keys,saved);restored.add(card);}
      }
      await instanceStore.remember(uniqueCards);
      for (const card of uniqueCards) {
        if(suppressNativeDuplicate(card))continue;
        const shouldContinue = () =>
          enabled && generation === currentGeneration && card.isConnected !== false && !hasNativeCardStats(card);
        if (!shouldContinue()) continue;
        if(!force && restored.has(card))continue;
        const keys=identity(card), snapshot=JSON.stringify(keys);
        const saved=previous(keys);
        if(saved && !force){render(card,saved.result);continue;}
        let cardId = getCanonicalCardId(card, instanceStore.lookup);
        if(!cardId && saved)cardId=saved.cardId;
        if (!cardId && (hasClass(card,'trade__inventory-item') || hasClass(card,'trade__main-item')) && client.resolveInstance) {
          try {
            cardId = await client.resolveInstance(card.getAttribute('data-id'),shouldContinue,card.getAttribute('data-rank') || undefined);
            if(cardId && shouldContinue()) await instanceStore.rememberPair(card.getAttribute('data-id'),cardId);
          } catch (_) { cardId=null; }
        }
        if (!shouldContinue()) {suppressNativeDuplicate(card);continue;}
        if (!cardId) {
          if(previous(keys))continue;
          render(card,{status:'error',ownersCount:null,needCount:null,tradeCount:null,duplicates:null,users:{owners:[],need:[],trade:[]}});
          continue;
        }
        const result = await client.load(cardId, { force }, shouldContinue, partial => {
          if (!shouldContinue()) return;
          if (JSON.stringify(identity(card)) !== snapshot) return;
          render(card, {...partial, duplicates: partial.duplicates ?? previous(keys)?.result.duplicates ?? null});
        });
        if (!shouldContinue()) {suppressNativeDuplicate(card);continue;}
        if(result.status==='ready')remember([...keys,'card:'+cardId],{cardId,result});
        // The site may reuse a DOM element for a different card while a request runs.
        if(JSON.stringify(identity(card))!==snapshot && !keys.some(k=>identity(card).includes(k)))continue;
        render(card,result.status==='ready'?result:(previous(keys)?.result || result));
      }
    }

    function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return enabled;
      enabled = next;
      generation += 1;
      return enabled;
    }

    return { process, setEnabled, clearRetained:()=>retained.clear(), isEnabled: () => enabled };
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
    root,
    storage,
    Observer,
    schedule,
  }) {
    const enabledKey = 'animesssCardHelper.autoLootEnabled';
    const handledNotifications = new WeakSet();
    let enabled = false;
    let observer = null;

    function closeCardModal() {
      const closeButton = root.querySelector(
        '.ui-dialog[aria-describedby="card-modal"] .ui-dialog-titlebar-close, '
        + '.modalfixed .ui-dialog-titlebar-close',
      );
      if (closeButton) closeButton.click();
    }

    function runNow() {
      if (!enabled) return false;
      const notification = root.querySelector('.card-notification');
      if (!notification || handledNotifications.has(notification)) return false;
      handledNotifications.add(notification);
      notification.click();
      schedule(closeCardModal);
      return true;
    }

    function startObserver() {
      if (!enabled || observer !== null) return;
      observer = new Observer(() => {
        runNow();
      });
      observer.observe(root, { childList: true, subtree: true });
      runNow();
    }

    function stopObserver() {
      if (observer === null) return;
      observer.disconnect();
      observer = null;
    }

    async function initialize() {
      const result = await storage.get(enabledKey);
      enabled = result && result[enabledKey] === true;
      startObserver();
      return enabled;
    }

    async function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return enabled;
      enabled = next;
      await storage.set({ [enabledKey]: enabled });
      if (enabled) {
        startObserver();
      } else {
        stopObserver();
      }
      return enabled;
    }

    function stop() {
      enabled = false;
      stopObserver();
    }

    return { initialize, setEnabled, runNow, stop };
  }

  function createClubBoostJournal({ storage, now = Date.now, log = console }) {
    const key = 'animesssCardHelper.clubBoostJournalV1';
    let pending = Promise.resolve();
    function enqueue(action) {
      pending = pending.then(action).catch((error) => {
        log.error('Не удалось сохранить журнал авто-взноса:', error);
      });
      return pending;
    }
    async function read() {
      const result = await storage.get(key);
      return Array.isArray(result?.[key]) ? result[key] : [];
    }
    function record(event, details = {}) {
      const entry = { time: new Date(now()).toISOString(), event, ...details };
      return enqueue(async () => {
        const entries = await read();
        await storage.set({ [key]: [...entries, entry].slice(-500) });
      });
    }
    return {
      record,
      async getEntries() { await pending; return read(); },
      clear: () => enqueue(() => storage.set({ [key]: [] })),
    };
  }

  function createClubBoostController({
    root,
    storage,
    now = Date.now,
    setTimeout,
    clearTimeout,
    sleep,
    pressContributeKey = () => {},
    notify,
    isBoostPage,
    journal = { record() {} },
    reloadPage,
    reloadStorage = storage,
    refreshTask = () => false,
  }) {
    const enabledKey = 'animesssCardHelper.clubBoostEnabled';
    const moscowOffsetMs = 3 * 60 * 60 * 1000;
    const keyIntervalMs = 500;
    const completedKey = 'animesssCardHelper.clubBoostCompletedDate';
    let completedDate = '';
    let settingsRevision = 0;
    let initialized = false;
    let awaitingFreshProgress = false;
    let enabled = false;
    let timer = null;
    let running = false;
    let preparing = false;
    let reloadRequested = false;
    const reloadKey = 'animesssCardHelper.clubBoostReloadDate';

    function moscowDate() {
      return new Date(now() + moscowOffsetMs).toISOString().slice(0, 10);
    }

    async function startScheduledRun() {
      if (!enabled || !isBoostPage() || running || preparing || reloadRequested) return;
      preparing = true;
      try {
        if (!isContributionWindowOpen()) { scheduleStart(); return; }
        if (reloadPage) {
          const saved = await reloadStorage.get(reloadKey);
          if (!enabled || !isContributionWindowOpen()) return;
          if (saved?.[reloadKey] !== moscowDate()) {
            await reloadStorage.set({ [reloadKey]: moscowDate() });
            await journal.record('Перезагрузка страницы перед авто-взносом', { date: moscowDate() });
            if (!enabled || !isContributionWindowOpen()) return;
            reloadRequested = true;
            reloadPage();
            return;
          }
          await journal.record('Страница обновлена сегодня; переход к авто-взносу');
        }
        await runNow();
      } catch (error) {
        await journal.record('Ошибка подготовки авто-взноса', { message: String(error?.message || error).slice(0, 500) });
        notify('error', 'Не удалось подготовить авто-взнос. Проверьте журнал.');
      } finally {
        preparing = false;
      }
    }

    function moscowTarget(value, hour, minute = 0) {
      const shifted = new Date(value + moscowOffsetMs);
      return Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate(),
        hour, minute, 0, 0,
      ) - moscowOffsetMs;
    }

    function isContributionWindowOpen(value = now()) {
      return value >= moscowTarget(value, 21, 1) &&
        value < moscowTarget(value, 22, 30);
    }

    function isClubClosed() {
      const progress = root.querySelector(
        '#my-progress .pbar__track[role="progressbar"]',
      );
      if (!progress) return false;
      const current = Number.parseInt(progress.getAttribute('aria-valuenow'), 10);
      const maximum = Number.parseInt(progress.getAttribute('aria-valuemax'), 10);
      return Number.isFinite(current) &&
        Number.isFinite(maximum) &&
        maximum > 0 &&
        current >= maximum;
    }

    function getBoostDiagnostics() {
      const progress = root.querySelector('#my-progress .pbar__track[role="progressbar"]');
      const refresh = root.querySelector('.club__boost__refresh-btn');
      const donate = root.querySelector('.club__boost-btn');
      return {
        progressCurrent: progress?.getAttribute('aria-valuenow') ?? null,
        progressMaximum: progress?.getAttribute('aria-valuemax') ?? null,
        refreshButtonPresent: Boolean(refresh),
        donateButtonPresent: Boolean(donate),
        refreshDisabled: Boolean(refresh?.disabled),
        donateDisabled: Boolean(donate?.disabled),
        cardId: getCurrentCardId(),
      };
    }

    function getCurrentCardId() {
      const cardControl = root.querySelector(
        '.club__boost-btn[data-card-id], ' +
        '.club__boost__refresh-btn[data-card-id]',
      );
      if (!cardControl) return '';
      const attribute = typeof cardControl.getAttribute === 'function'
        ? cardControl.getAttribute('data-card-id')
        : null;
      return String(attribute || cardControl.dataset?.cardId || '').trim();
    }

    async function waitForCardChange(previousCardId) {
      await sleep(keyIntervalMs);
      const currentCardId = getCurrentCardId();
      return Boolean(currentCardId && currentCardId !== previousCardId);
    }

    function millisecondsUntilTarget() {
      const current = now();
      let target = moscowTarget(current, 21, 1);
      const end = moscowTarget(current, 22, 30);
      if (current >= end || completedDate === moscowDate()) {
        target += 24 * 60 * 60 * 1000;
      }
      return Math.max(0, target - current);
    }

    function stopTimer() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    }

    function scheduleStart() {
      if (
        !enabled ||
        !isBoostPage() ||
        reloadRequested ||
        timer !== null
      ) return;
      let delay = millisecondsUntilTarget();
      // An initially full page is unverified. Background checks, not a zero-delay
      // local retry loop, will refresh it at 21:02, 21:03 and 21:05.
      if (awaitingFreshProgress && delay === 0) delay = moscowTarget(now(),21,1)+86400000-now();
      journal.record('Запуск запланирован', { startAt: new Date(now() + delay).toISOString() });
      timer = setTimeout(() => {
        timer = null;
        return startScheduledRun();
      }, delay);
    }

    async function initialize() {
      const revision = settingsRevision;
      const enabledResult = await storage.get(enabledKey);
      completedDate = (await storage.get(completedKey))?.[completedKey] || '';
      if (revision === settingsRevision) enabled = enabledResult && enabledResult[enabledKey] === true;
      initialized = true;
      if (isBoostPage()) journal.record('Скрипт загружен на странице клуба', {
        enabled, closed: isClubClosed(), cardId: getCurrentCardId(),
        ...getBoostDiagnostics(),
      });
      scheduleStart();
      return enabled;
    }

    async function setEnabled(value) {
      enabled = value === true;
      await storage.set({ [enabledKey]: enabled });
      journal.record(enabled ? 'Авто-взнос включён' : 'Авто-взнос выключен', {
        boostPage: isBoostPage(), closed: isClubClosed(),
      });
      if (enabled) scheduleStart();
      else stopTimer();
      return enabled;
    }

    function syncEnabled(value) {
      settingsRevision += 1;
      const next = value === true;
      if (enabled === next) return enabled;
      enabled = next;
      journal.record('Настройка авто-взноса синхронизирована', {enabled, boostPage:isBoostPage()});
      if (!enabled) stopTimer();
      else if (initialized && !running && !preparing) scheduleStart();
      return enabled;
    }

    async function runNow() {
      if (enabled && isBoostPage() && isContributionWindowOpen() && isClubClosed() && !running && completedDate !== moscowDate()) {
        awaitingFreshProgress = true;
        journal.record('600/600 при загрузке: завершение дня не подтверждено; ожидается повторная проверка',getBoostDiagnostics());
      }
      if (!enabled || !isBoostPage() || isClubClosed() || running || completedDate === moscowDate()) {
        journal.record('Запуск пропущен', {
          enabled, boostPage: isBoostPage(), closed: isClubClosed(), running,
          ...getBoostDiagnostics(),
        });
        if (enabled && isBoostPage() && isClubClosed() && !running) scheduleStart();
        return false;
      }
      running = true;
      awaitingFreshProgress = false;
      stopTimer();
      let attempts = 0;
      let contributed = 0;
      let failed = false;
      journal.record('Цикл авто-взноса начат', { cardId: getCurrentCardId() });
      try {

        while (
          enabled &&
          isContributionWindowOpen() &&
          !isClubClosed()
        ) {
          const previousCardId = getCurrentCardId();
          attempts += 1;
          journal.record('Попытка авто-взноса', { attempt: attempts, cardId: previousCardId || 'не найден' });
          const action = pressContributeKey();
          journal.record('Действие авто-взноса; следующая проверка через 0,5 секунды', {
            attempt: attempts, action: action || 'S', ...getBoostDiagnostics(),
          });
          if (await waitForCardChange(previousCardId)) {
            contributed += 1;
            journal.record('Карта сменилась (сам взнос сервером не подтверждён)', {
              previousCardId, cardId: getCurrentCardId(), observedChanges: contributed,
            });
            continue;
          }
          if (
            enabled &&
            isContributionWindowOpen() &&
            !isClubClosed()
          ) {
            journal.record('Карта не сменилась; повторная попытка', {cardId: getCurrentCardId()});
          }
        }
        return { contributed };
      } catch (error) {
        failed = true;
        enabled = false; // A broken extension connection must not cause a retry storm.
        journal.record('Ошибка авто-взноса', { message: String(error?.message || error).slice(0, 500) });
        notify('error', 'Ошибка автоматического взноса карт в клуб.');
        return false;
      } finally {
        journal.record('Цикл остановлен', {
          reason: failed ? 'ошибка' : !enabled ? 'выключен вручную' : isClubClosed() ? 'клуб заполнен' : 'время работы закончилось',
          attempts, observedChanges: contributed,
        });
        running = false;
        if (isClubClosed() && isContributionWindowOpen()) await markCompleted();
        scheduleStart();
      }
    }

    async function markCompleted() {
      if (completedDate === moscowDate()) return;
      completedDate = moscowDate();
      stopTimer();
      try { await storage.set({[completedKey]: completedDate}); }
      catch (error) { journal.record('Не удалось сохранить завершение дня', {message:String(error)}); }
      journal.record('Клуб заполнен; авто-взнос завершён до следующего дня', getBoostDiagnostics());
    }

    function stop() {
      enabled = false;
      stopTimer();
      journal.record('Авто-взнос остановлен');
    }

    async function checkScheduledRun(minute = 5) {
      if (![2,3,5].includes(minute)) return;
      if (!initialized || !isBoostPage()) return;
      const saved = await storage.get(enabledKey);
      completedDate = (await storage.get(completedKey))?.[completedKey] || '';
      syncEnabled(saved?.[enabledKey] === true);
      const eligible = enabled && !running && !preparing && !reloadRequested &&
        completedDate !== moscowDate() && isContributionWindowOpen() &&
        now() >= moscowTarget(now(),21,minute);
      journal.record(`Контрольная проверка авто-взноса 21:0${minute}`, {
        enabled, running, preparing, completedToday:completedDate===moscowDate(), retry:eligible,
      });
      if (!eligible) return;
      stopTimer();
      if (isClubClosed() && reloadPage) {
        const checkKey = 'animesssCardHelper.clubBoostRecheck:' + minute;
        const previous = await reloadStorage.get(checkKey);
        if (!enabled || running || preparing || !isContributionWindowOpen()) return;
        if (previous?.[checkKey] !== moscowDate()) {
          await reloadStorage.set({[checkKey]:moscowDate()});
          await journal.record('Повторная перезагрузка для проверки 600/600', {minute});
          if (!enabled || running || !isContributionWindowOpen()) return;
          reloadRequested = true;
          reloadPage();
          return;
        }
      }
      await startScheduledRun();
    }

    return { initialize, setEnabled, syncEnabled, checkScheduledRun, runNow, stop };
  }

  function createChatCrystalController({
    root,
    storage,
    setInterval,
    clearInterval,
    sleep = async () => {},
    log = console,
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
        if (returnButton) {
          returnButton.click();
          // Resuming the site's chat starts an asynchronous loadNew request.
          for (let attempt = 0; attempt < 10 && enabled; attempt += 1) {
            await sleep(1000);
            if (!enabled) return false;
            await scan();
          }
        }
        await scan();
        return true;
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          stop();
          return false;
        }
        log.error('Ошибка проверки авто-кристалла:', error);
        return false;
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
      function element(node){return node?.nodeType===1?node:node?.parentElement;}
      function own(node){return Boolean(element(node)?.closest?.(HELPER_STATS_SELECTOR));}
      function native(node){const el=element(node);return Boolean(el?.closest?.(NATIVE_STATS_SELECTOR)||el?.querySelector?.(NATIVE_STATS_SELECTOR));}
      function queueOwner(node){
        const el=element(node);if(!el)return;
        queue(el.closest?.(selector));
        const wrapper=el.closest?.('.accshop__card, .anime-cards__item-wrapper');
        if(wrapper)collect(wrapper);
      }
      for (const mutation of mutations) {
        if(own(mutation.target))continue;
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes || []) collect(node);
          if(element(mutation.target)?.closest?.(NATIVE_STATS_SELECTOR) ||
            [...(mutation.addedNodes||[]),...(mutation.removedNodes||[])].some(node=>!own(node)&&native(node)))queueOwner(mutation.target);
        } else if(mutation.type==='characterData' && native(mutation.target)) {
          queueOwner(mutation.target);
        } else if (
          mutation.type === 'attributes' &&
          ['data-id', 'data-card-id', 'card-id', 'data-original-id', 'data-owner-id', 'data-rank'].includes(mutation.attributeName) &&
          mutation.target &&
          typeof mutation.target.matches === 'function' &&
          mutation.target.matches(selector)
        ) {
          queue(mutation.target);
        } else if(mutation.type==='attributes' && native(mutation.target)) {
          queueOwner(mutation.target);collect(mutation.target);
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-id', 'data-card-id', 'card-id', 'data-original-id', 'data-owner-id', 'data-rank', 'class', 'style', 'hidden', 'aria-hidden', 'title', 'aria-label'],
    });

    function scan() {
      const cards = [...root.querySelectorAll(selector)];
      if (cards.length > 0) onCards(cards);
    }

    return { scan, disconnect: () => observer.disconnect() };
  }

  const api = {
    hasNativeCardStats,
    cardStatsWrapper,
    CARD_SELECTOR,
    collectTradeCandidates,
    createAutoLootController,
    createChatCrystalController,
    createClubBoostController,
    createClubBoostJournal,
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
