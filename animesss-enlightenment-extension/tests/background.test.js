'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('club wait runs a bounded 0.5-second worker timer only for the club top frame', () => {
  let listener; const timers=[]; const replies=[];
  const chrome={runtime:{onMessage:{addListener:fn=>{listener=fn;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    storage:{local:{get:async()=>({})},onChanged:{addListener(){}}},
    alarms:{clear:async()=>{},onAlarm:{addListener(){}}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),
    {chrome,console,URL,setTimeout:(fn,ms)=>timers.push({fn,ms})});
  const sender={tab:{id:1,active:false},frameId:0,url:'https://animesss.com/clubs/boost/?id=402'};
  assert.equal(listener({type:'animesss-club-wait'},sender,r=>replies.push(r)),true);
  assert.equal(timers[0].ms,500);
  assert.equal(replies.length,0);
  timers[0].fn();assert.equal(replies[0].ok,true);
  for(const invalid of [{...sender,frameId:1},{...sender,url:'https://other.com/clubs/boost/?id=402'},
    {...sender,url:'https://animesss.com/clubs/boost/?id=999'}]) {
    assert.equal(listener({type:'animesss-club-wait'},invalid,()=>assert.fail()),undefined);
  }
  assert.equal(timers.length,1);
});

test('background alarm checks inactive site tabs and stops when disabled', async () => {
  let enabled = true;
  let onAlarm;
  let onChanged;
  const sent = [];
  const alarms = [];
  const chrome = {
    storage: {
      local: { get: async key => ({ [key]: enabled }) },
      onChanged: { addListener: fn => { onChanged = fn; } },
    },
    alarms: {
      get: async () => null,
      create: async (name, options) => alarms.push({ name, period: options.periodInMinutes }),
      clear: async () => alarms.push('cleared'),
      onAlarm: { addListener: fn => { onAlarm = fn; } },
    },
    tabs: {
      query: async options => {
        assert.equal(options.active, undefined);
        assert.deepEqual(Array.from(options.url), ['https://animesss.com/*', 'https://animesss.tv/*']);
        return [{ id: 1, active: false }, { id: 2, active: true }, { id: 3, discarded: true }];
      },
      sendMessage: async (id, message) => { sent.push([id, message.type]); },
    },
    runtime: { onMessage: {addListener() {}}, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), { chrome, console });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alarms[0].period, 3);
  await onAlarm({ name: 'animesss-crystal-check' });
  assert.deepEqual(sent, [[1, 'animesss-check-crystal'], [2, 'animesss-check-crystal']]);
  enabled = false;
  onChanged({ 'animesssCardHelper.autoCrystalEnabled': { newValue: false } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alarms.at(-1), 'cleared');
  await onAlarm({ name: 'animesss-crystal-check' });
  assert.equal(sent.length, 2);
});
