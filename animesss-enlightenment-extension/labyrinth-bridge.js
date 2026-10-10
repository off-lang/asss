// Read-only adapter for the site's mapData format documented by
// Animesss Labyrinth Map 10.45 (VladLIO, MIT). No cloud sync or game actions.
(() => {
  if (window.__animesssLocalMapBridge) return;
  window.__animesssLocalMapBridge = true;
  let timer = null;
  function publish() {
    const map = window.labyrinthData?.mapData;
    if (!map || !Array.isArray(map.steps)) return;
    // Deliberately do not expose the rest of labyrinthData or account tokens.
    window.postMessage({type: 'animesss-local-map-v1', map: {
      current: {x: map.current?.x, y: map.current?.y},
      steps: map.steps.slice(-10000).map(s => ({x: s.x, y: s.y, event: s.event}))
    }}, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.type !== 'animesss-local-map-control-v1') return;
    if (event.data.enabled === true) {
      if (timer === null) timer = setInterval(publish, 1500);
      publish();
    } else if (event.data.enabled === false) {
      clearInterval(timer);
      timer = null;
    }
  });
  // Start only after the isolated script has loaded the saved preference.
  window.postMessage({type:'animesss-local-map-ready-v1'}, location.origin);
})();
