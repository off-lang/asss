'use strict';
if (typeof importScripts === 'function') importScripts('labyrinth-cloud.js');
if (typeof importScripts === 'function') importScripts('club-watchdog.js');

const CRYSTAL_ALARM = 'animesss-crystal-check';
const ENABLED_KEY = 'animesssCardHelper.autoCrystalEnabled';

// Each bounded wait is an extension event, not a hidden-page chained timer.
// The content script rechecks enabled, time window and progress after waking.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'animesss-club-wait') return;
  let url;
  try { url = new URL(sender.url); } catch { return; }
  if (!sender.tab || sender.frameId !== 0 || url.protocol !== 'https:' ||
      !['animesss.com','animesss.tv'].includes(url.hostname) ||
      url.pathname !== '/clubs/boost/' || url.searchParams.get('id') !== '402') return;
  setTimeout(() => sendResponse({ok:true}), 500);
  return true;
});

async function syncCrystalAlarm() {
  const saved = await chrome.storage.local.get(ENABLED_KEY);
  if (saved[ENABLED_KEY] === true) {
    if (!await chrome.alarms.get(CRYSTAL_ALARM)) {
      await chrome.alarms.create(CRYSTAL_ALARM, { periodInMinutes: 3 });
    }
  } else {
    await chrome.alarms.clear(CRYSTAL_ALARM);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CRYSTAL_ALARM) return;
  const saved = await chrome.storage.local.get(ENABLED_KEY);
  if (saved[ENABLED_KEY] !== true) return;
  const tabs = await chrome.tabs.query({ url: ['https://animesss.com/*', 'https://animesss.tv/*'] });
  await Promise.allSettled(tabs.filter(tab => !tab.discarded).map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: 'animesss-check-crystal' })
  ));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ENABLED_KEY]) void syncCrystalAlarm().catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => { void syncCrystalAlarm().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { void syncCrystalAlarm().catch(console.error); });
void syncCrystalAlarm().catch(console.error);
