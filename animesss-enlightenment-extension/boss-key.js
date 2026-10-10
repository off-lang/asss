'use strict';

function createBossKeyRepeater({doc, KeyboardEventClass, setInterval, clearInterval, isConnected, onState = () => {}}) {
  let timer = null;
  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    onState(false);
  }
  function tick() {
    if (!isConnected() || doc.hidden) { stop(); return; }
    const active = doc.activeElement;
    if (active?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || '')) return;
    const options = {key:'s',code:'KeyS',keyCode:83,which:83,charCode:0,bubbles:true,cancelable:true};
    for (const type of ['keydown','keypress','keyup']) doc.dispatchEvent(new KeyboardEventClass(type, options));
  }
  return {
    start() {
      if (timer !== null || !isConnected() || doc.hidden) return;
      timer = setInterval(tick, 50);
      onState(true);
      tick();
    },
    stop,
    get running() { return timer !== null; },
  };
}

if (typeof module !== 'undefined') module.exports = {createBossKeyRepeater};
else if (/^\/boss_invansion\/$/.test(location.pathname)) {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>
    :host{position:fixed;bottom:24px;left:18px;z-index:100000;font:14px system-ui}
    button{padding:10px 14px;border:1px solid #65708a;border-radius:8px;background:#252c3d;color:#fff;cursor:pointer;font:inherit}
    button[aria-pressed="true"]{background:#21603c;border-color:#67c490}
    button:focus-visible{outline:3px solid #efc768;outline-offset:3px}
  </style><button type="button" aria-pressed="false" title="Повтор клавиши S каждые 50 мс. При уходе с вкладки останавливается.">Авто-S: выкл · 50 мс</button>`;
  const button = shadow.querySelector('button');
  const repeater = createBossKeyRepeater({doc:document,KeyboardEventClass:KeyboardEvent,
    setInterval:globalThis.setInterval.bind(globalThis),clearInterval:globalThis.clearInterval.bind(globalThis),
    isConnected:() => Boolean(globalThis.chrome?.runtime?.id),
    onState:running => {
      button.setAttribute('aria-pressed',String(running));
      button.textContent = `Авто-S: ${running?'вкл':'выкл'} · 50 мс`;
    }});
  button.onclick = () => repeater.running ? repeater.stop() : repeater.start();
  window.addEventListener('blur',repeater.stop);
  window.addEventListener('pagehide',repeater.stop);
  document.addEventListener('visibilitychange',() => { if(document.hidden)repeater.stop(); });
}
