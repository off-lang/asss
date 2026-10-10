const test=require('node:test');
const assert=require('node:assert/strict');
const {createClient,parseNearby}=require('../labyrinth-cloud.js');
function binaryMap(rows) {
  const n=rows.length, buffer=new ArrayBuffer(24+n*6), view=new DataView(buffer);
  view.setUint32(0,0x4c4d4632,false);view.setUint16(4,24,true);view.setUint16(6,6,true);
  view.setUint32(8,n,true);view.setUint32(16,3670850329,true);
  rows.forEach((r,i)=>{
    view.setInt16(24+i*2,r.x,true);view.setInt16(24+2*n+i*2,r.y,true);
    view.setUint8(24+4*n+i,r.type || 1);view.setUint8(24+5*n+i,r.flags || 0);
  });
  return buffer;
}
function binaryMapV3(rows, extra={types:['unknown','empty','new_room2']}) {
  const base=binaryMap(rows), tail=new TextEncoder().encode(JSON.stringify(extra));
  const buffer=new ArrayBuffer(base.byteLength+tail.length);
  new Uint8Array(buffer).set(new Uint8Array(base));
  new Uint8Array(buffer,base.byteLength).set(tail);
  const view=new DataView(buffer);
  view.setUint32(0,0x4c4d4633,false);view.setUint32(20,tail.length,true);
  view.setUint32(16,123,true); // Dynamic names supersede the legacy hash.
  return buffer;
}
test('v3 uses validated dynamic room types, keeps flags and filters around the requested point',()=>{
  const result=parseNearby(binaryMapV3([{x:-20,y:30,type:2},{x:-19,y:30,type:2,flags:8},{x:81,y:30,type:2}]),{x:-20,y:30});
  assert.deepEqual(result,{rooms:[{x:-20,y:30,event:'new_room2'},{x:-19,y:30,event:'room_trap'}],next:null});
});
test('v3 rejects truncated tails, malformed JSON and unsafe dynamic names',()=>{
  const good=binaryMapV3([{x:0,y:0,type:2}]);
  assert.throws(()=>parseNearby(good.slice(0,-1),{x:0,y:0}),/формат/);
  const bad=good.slice(0);new Uint8Array(bad)[bad.byteLength-1]=0;
  assert.throws(()=>parseNearby(bad,{x:0,y:0}),/формат/);
  for(const types of [[],['<script>'],Array(257).fill('empty')]) {
    assert.throws(()=>parseNearby(binaryMapV3([],{types}),{x:0,y:0}),/формат/);
  }
});
test('v3 accepts the upstream room limit while creating objects only for nearby rooms',()=>{
  const buffer=binaryMap(Array.from({length:250001},()=>({x:200,y:200})));
  new DataView(buffer).setUint32(0,0x4c4d4633,false);
  assert.deepEqual(parseNearby(buffer,{x:0,y:0}),{rooms:[],next:null});
});
test('fast map keeps only inclusive ±100 area around actual negative coordinates',()=>{
  const result=parseNearby(binaryMap([
    {x:-50,y:-70,type:3},{x:50,y:30},{x:-150,y:-170},
    {x:51,y:-70},{x:-50,y:-171},{x:-49,y:-70,flags:4},
  ]),{x:-50,y:-70});
  assert.deepEqual(result,{rooms:[
    {x:-50,y:-70,event:'quiz'},{x:50,y:30,event:'empty'},
    {x:-150,y:-170,event:'empty'},{x:-49,y:-70,event:'room_gift'},
  ],next:null});
});
test('fast map rejects invalid position, truncated data and changed event schema',()=>{
  assert.throws(()=>parseNearby(binaryMap([]),{x:NaN,y:0}));
  assert.throws(()=>parseNearby(new ArrayBuffer(10),{x:0,y:0}));
  const buffer=binaryMap([{x:0,y:0}]);
  new DataView(buffer).setUint32(16,1,true);
  assert.throws(()=>parseNearby(buffer,{x:0,y:0}),/формат/);
  assert.throws(()=>parseNearby(binaryMap([{x:0,y:0}]).slice(0,25),{x:0,y:0}),/формат/);
});
test('nearby uses authenticated compact endpoint without sending player coordinates',async()=>{
  const values={},calls=[];
  const client=createClient({storage:{get:async k=>({[k]:values[k]}),set:async o=>Object.assign(values,o)},
    uuid:()=> 'test',sleep:async()=>{},fetch:async(url,options)=>{
      calls.push({url,options});
      if(options.headers['X-Script-Version']!=='10.52')return {ok:true,text:async()=>'{"outdated":true,"latest_script":"10.52"}'};
      return url.endsWith('/map/fast?v=3')
        ? {ok:true,headers:{get:()=> 'application/octet-stream'},arrayBuffer:async()=>binaryMapV3([{x:23,y:-40,type:2},{x:1000,y:1000}],{types:['unknown','empty','quiz']})}
        : {ok:true,text:async()=>'{"ok":true}'};
    }});
  assert.deepEqual(await client.load({username:'Alex59',nearby:{x:23,y:-40}}),{rooms:[{x:23,y:-40,event:'quiz'}],next:null});
  assert.deepEqual(calls.map(c=>c.url.split('/api')[1]),['/device/bind','/map/fast?v=3']);
  assert.equal(calls[1].options.headers.Authorization,'Bearer lmd_test');
  assert.ok(!JSON.stringify(calls).includes('-40'));
});
test('nearby stops on explicit blocked response without another request',async()=>{
  const {client,calls}=setup([{ok:true},{blocked:true}]);
  await assert.rejects(client.load({username:'Alex59',nearby:{x:0,y:0}}),/blocked/);
  assert.equal(calls.length,2);
});
function setup(responses){
  const values={},calls=[];
  const client=createClient({storage:{get:async k=>({[k]:values[k]}),set:async o=>Object.assign(values,o)},
    uuid:()=> 'test-device',sleep:async()=>{},fetch:async(url,options)=>{
      calls.push({url,options});
      const data=responses.shift();
      return data instanceof ArrayBuffer ? {ok:true,headers:{get:()=> 'application/octet-stream'},arrayBuffer:async()=>data} : {ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(data)};
    }});
  return {client,values,calls};
}
test('cloud sends only nick and new device token; strips other room data',async()=>{
  const {client,calls}=setup([{ok:true},binaryMapV3([{x:1,y:-2,type:2}],{types:['unknown','empty','quiz'],private:'not forwarded'})]);
  const page=await client.load({username:'Alex59'});
  assert.deepEqual(JSON.parse(calls[0].options.body),{username:'Alex59',device_token:'lmd_test-device'});
  assert.deepEqual(page,{rooms:[{x:1,y:-2,event:'quiz'}],next:null});
  for(const call of calls){assert.equal(call.options.credentials,'omit');assert.equal(call.options.referrerPolicy,'no-referrer');assert.equal(call.options.redirect,'error');}
  assert.ok(calls[1].url.endsWith('/map/fast?v=3'));
});
test('full compact map keeps distant rooms and reuses identity without rebinding',async()=>{
  const data=binaryMap([{x:1,y:2},{x:1000,y:1000}]);
  const {client,calls}=setup([{ok:true},data,data]);
  const first=await client.load({username:'Алекс'});
  assert.equal(first.rooms.length,2);
  assert.equal(first.next,null);
  await client.load({username:'Алекс'});
  assert.equal(calls.length,3);
  assert.equal(calls[1].options.headers['X-Player'],encodeURIComponent('Алекс'));
  assert.ok(calls[2].url.endsWith('/map/fast?v=3'));
});
test('disabled map makes no request',async()=>{
  const {client,calls,values}=setup([]);values['animesss.localLabyrinth.enabled']=false;
  await assert.rejects(client.load({username:'Alex59'}),/выключен/);assert.equal(calls.length,0);
});
test('ACC proof is sent only after bind 403, only numeric fields, and is not stored',async()=>{
  const values={},calls=[];let count=0;
  const client=createClient({storage:{get:async k=>({[k]:values[k]}),set:async o=>Object.assign(values,o)},uuid:()=> 'new',sleep:async()=>{},
    fetch:async(url,options)=>{
      calls.push({url,options});count++;
      if(count===1)return {ok:false,status:403};
      return count===2 ? {ok:true,text:async()=>'{"ok":true}'} : {ok:true,headers:{get:()=> 'application/octet-stream'},arrayBuffer:async()=>binaryMap([])};
    }});
  await assert.rejects(client.load({username:'Alex59'}),e=>e.needsAcc===true);
  await client.load({username:'Alex59',accRows:[{acc_delta:-2,acc_after:10,description:'private',date:'private'}]});
  assert.equal(JSON.parse(calls[0].options.body).acc_rows,undefined);
  assert.deepEqual(JSON.parse(calls[1].options.body).acc_rows,[{acc_delta:-2,acc_after:10}]);
  assert.ok(!JSON.stringify(values).includes('acc_delta'));
  assert.equal(calls.length,3);
});
test('explicit HTTP error codes are reported without tokens or unwanted registration',async()=>{
  for(const [status,code,expected] of [[403,'blocked','blocked'],[409,'device_limit','device_limit'],[410,'device_revoked','device_revoked'],[429,'acc_proof_locked','acc_proof_locked']]) {
    const calls=[];
    const client=createClient({storage:{get:async()=>({}),set:async()=>{}},uuid:()=> 'test',sleep:async()=>{},fetch:async(url)=>{
      calls.push(url);return {ok:false,status,text:async()=>JSON.stringify({error:code,token:'SECRET'})};
    }});
    await assert.rejects(client.load({username:'Tester'}),e=>e.message.includes(expected)&&e.message.includes(String(status))&&!e.message.includes('SECRET')&&!e.needsAcc);
    assert.equal(calls.length,1);
  }
});
test('full map exceeding UI capacity fails explicitly while nearby can filter it',()=>{
  const data=binaryMap(Array.from({length:200001},()=>({x:300,y:300})));
  assert.throws(()=>parseNearby(data,null),/200/);
  assert.deepEqual(parseNearby(data,{x:0,y:0}),{rooms:[],next:null});
});
test('blocked map does not trigger account proof or repeated registration',async()=>{
  const {client,calls}=setup([{ok:true},{blocked:true}]);
  await assert.rejects(client.load({username:'Alex59'}),e=>!e.needsAcc && /blocked/.test(e.message));
  assert.equal(calls.length,2);
});
test('outdated dummy map and auth refusal are errors, not successful empty maps',async()=>{
  for(const data of [{outdated:true,rooms:[]},{need_auth:true,rooms:[]}]){
    const {client}=setup([{ok:true},data]);await assert.rejects(client.load({username:'Alex59'}));
  }
});
test('HTTP 426 stops with a protocol update message, never rebinding or retrying',async()=>{
  const calls=[];
  const client=createClient({storage:{get:async k=>({[k]:k.startsWith('animesss.sharedMap.device:')?{token:'existing',bound:true}:true}),set:async()=>{}},uuid:()=> 'unused',sleep:async()=>{},fetch:async(url)=>{
    calls.push(url);return {ok:false,status:426};
  }});
  await assert.rejects(client.load({username:'Alex59',nearby:{x:0,y:0}}),/новую версию протокола/);
  assert.equal(calls.length,1);
});
test('invalid map auth rebinds existing device exactly once then retries binary map',async()=>{
  const {client,calls}=setup([{ok:true},{error:'invalid_auth'},{ok:true},binaryMap([{x:7,y:8}])]);
  assert.equal((await client.load({username:'Tester'})).rooms[0].x,7);
  assert.deepEqual(calls.map(c=>c.url.split('/api')[1]),['/device/bind','/map/fast?v=3','/device/bind','/map/fast?v=3']);
  assert.equal(calls[0].options.body,calls[2].options.body);
  const repeated=setup([{ok:true},{need_auth:true},{ok:true},{need_auth:true}]);
  await assert.rejects(repeated.client.load({username:'Tester'}),/need_auth/);
  assert.equal(repeated.calls.length,4);
});
test('HTTP blocked on map stops without ACC proof or another bind',async()=>{
  const calls=[];
  const client=createClient({storage:{get:async k=>({[k]:k.startsWith('animesss.sharedMap.device:')?{token:'existing',bound:true}:true}),set:async()=>{}},uuid:()=> 'unused',sleep:async()=>{},fetch:async(url)=>{
    calls.push(url);return {ok:false,status:403,text:async()=>'{"code":"blocked"}'};
  }});
  await assert.rejects(client.load({username:'Tester'}),e=>/blocked/.test(e.message)&&!e.authRequired&&!e.needsAcc);
  assert.equal(calls.length,1);
});
