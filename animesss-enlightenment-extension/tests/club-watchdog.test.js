const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('watchdog schedules 21:05 Moscow and contacts only one eligible open club tab',async()=>{
  let alarm;const created=[],sent=[];
  class Clock extends Date{static now(){return Date.parse('2026-09-11T17:00:00Z');}}
  const chrome={storage:{local:{get:async key=>({[key]:true})},onChanged:{addListener(){}}},
    alarms:{get:async()=>null,create:async(name,opts)=>created.push(opts),onAlarm:{addListener:fn=>{alarm=fn;}}},
    runtime:{onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    tabs:{query:async()=>[{id:1,url:'https://animesss.com/clubs/boost/?id=1'},
      {id:2,url:'https://animesss.com/clubs/boost/?id=402',discarded:true},
      {id:3,url:'https://animesss.com/clubs/boost/?id=402'},
      {id:4,url:'https://animesss.com/clubs/boost/?id=402'}],
      sendMessage:async id=>{sent.push(id);return {accepted:true};}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../club-watchdog.js'),'utf8'),{chrome,Date:Clock,URL,console});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(created.map(item=>item.when),[2,3,5].map(minute=>Date.parse(`2026-09-11T18:0${minute}:00Z`)));
  assert.equal(created[0].periodInMinutes,1440);
  await alarm({name:'animesss-club-watchdog'});assert.deepEqual(sent,[3]);
});
