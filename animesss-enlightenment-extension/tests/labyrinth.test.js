'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {normalize,merge,label} = require('../labyrinth.js');
test('ACC parser extracts only amounts and balances from the dedicated table',()=>{
  const {parseAccRows}=require('../labyrinth.js');
  const doc={querySelectorAll:selector=>{
    assert.equal(selector,'.ncard-transactions__table tbody tr');
    return [['−1 000','2 500','private'],['+5','2505'],['bad','9']].map(row=>({querySelectorAll:()=>row.map(textContent=>({textContent}))}));
  }};
  assert.deepEqual(parseAccRows(doc),[{acc_delta:-1000,acc_after:2500},{acc_delta:5,acc_after:2505}]);
});

test('map preserves actual negative world coordinates, not viewport indices', () => {
  assert.deepEqual(normalize({current:{x:286,y:-90},steps:[{x:274,y:-90,event:'trap_back'}]}),
    {current:{x:286,y:-90},steps:[{x:274,y:-90,event:'trap_back'}]});
});
test('map keeps validated digit-containing event names from protocol v3',()=>{
  assert.equal(normalize({current:{x:0,y:0},steps:[{x:0,y:0,event:'new_room2'}]}).steps[0].event,'new_room2');
});
test('untrusted map messages reject invalid coordinates and oversized snapshots', () => {
  assert.equal(normalize({current:{x:NaN,y:0},steps:[]}),null);
  assert.equal(normalize({current:{x:0,y:0},steps:Array(10001).fill({x:0,y:0})}),null);
  assert.deepEqual(normalize({current:{x:0,y:0},steps:[{x:'1',y:0},{x:1,y:0,event:'<script>'}]}).steps,
    [{x:1,y:0,event:'unknown'}]);
});
test('merging remembers offscreen rooms and notes but refreshes changed room events', () => {
  const old = {'1,-1':{x:1,y:-1,event:'empty',note:'Вернуться'},'9,9':{x:9,y:9,event:'quiz'}};
  const next = merge(old,[{x:1,y:-1,event:'reward'}]);
  assert.equal(next['1,-1'].event,'reward');
  assert.equal(next['1,-1'].note,'Вернуться');
  assert.ok(next['9,9']);
  assert.equal(old['1,-1'].event,'empty');
});
test('result events have readable labels; unknown types remain visible', () => {
  assert.equal(label('echo_room_result'),'Отголосок');
  assert.equal(label('new_room'),'new_room');
});
test('bridge exports only map coordinates and events, never profile or tokens', () => {
  const messages=[]; let poll, listener;
  const window={labyrinthData:{secret:'no',mapData:{current:{x:3,y:-4,secret:'no'},
    steps:[{x:3,y:-4,event:'quiz',secret:'no'}]}},postMessage:(...args)=>messages.push(args),addEventListener:(_,fn)=>{listener=fn;}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../labyrinth-bridge.js'),'utf8'),
    {window,location:{origin:'https://animesss.com'},setInterval:fn=>{poll=fn;return 1;}});
  assert.equal(poll,undefined);
  messages.length=0;
  listener({source:window,origin:'https://animesss.com',data:{type:'animesss-local-map-control-v1',enabled:true}});
  assert.equal(messages[0][1],'https://animesss.com');
  assert.ok(!JSON.stringify(messages).includes('secret'));
  assert.equal(messages[0][0].map.current.y,-4);
  window.labyrinthData.mapData.current.y=-5;poll();
  assert.equal(messages[1][0].map.current.y,-5);
});

test('bridge toggle clears polling, rejects foreign messages and restarts only once', () => {
  let listener, starts=0; const stopped=[];
  const window={postMessage(){},addEventListener:(_,fn)=>{listener=fn;}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../labyrinth-bridge.js'),'utf8'),{
    window,location:{origin:'https://animesss.com'},
    setInterval:()=>++starts,clearInterval:id=>stopped.push(id),
  });
  const event=enabled=>({source:window,origin:'https://animesss.com',data:{type:'animesss-local-map-control-v1',enabled}});
  assert.equal(starts,0);
  listener({...event(true),origin:'https://other.com'});
  assert.equal(starts,0);
  listener(event(false));assert.equal(starts,0);
  listener(event(true));listener(event(true));assert.equal(starts,1);
  listener(event(false));assert.equal(stopped.at(-1),1);
  listener(event(true));assert.equal(starts,2);
});
