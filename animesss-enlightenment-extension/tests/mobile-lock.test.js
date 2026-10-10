const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = path.join(__dirname, '../mobile-lock.js');
function api() { assert.ok(fs.existsSync(source), 'mobile lock implementation must exist'); return require(source); }
test('Stop during asynchronous intent persistence prevents lock and unlock POSTs',async()=>{
  const {run,runUnlock}=api();let stop=false,posts=0;
  const common={sleep:async()=>{},stopped:()=>stop,log:()=>{}};
  const result=await run({...common,mode:'unlocked',readPage:async()=>({cards:[{rank:'a',id:'1',icons:['fa-unlock']}],next:false}),
    beforeLock:async()=>{await Promise.resolve();stop=true;},lockPage:async()=>{posts++;return {ok:true};}});
  assert.equal(posts,0);assert.equal(result.status,'stopped');
  stop=false;
  const undo=await runUnlock({...common,readPage:async()=>({cards:[{rank:'a',id:'1',icons:['fa-lock']}],next:false}),
    ledger:{confirmed:async()=>['1'],set:async()=>{await Promise.resolve();stop=true;}},unlockPage:async()=>{posts++;return {ok:true};}});
  assert.equal(posts,0);assert.equal(undo.status,'stopped');
});
test('only exact A and explicitly unlocked cards can be toggled', () => {
  const {classify} = api();
  assert.equal(classify({rank:'a',id:'42',icons:['fa-unlock']}),'unlock');
  assert.equal(classify({rank:'a_plus',id:'42',icons:['fa-unlock']}),'other');
  assert.equal(classify({rank:'a',id:'42',icons:['fa-lock']}),'locked');
  assert.equal(classify({rank:'a',id:'42',icons:['fa-trophy-alt']}),'unavailable');
  assert.equal(classify({rank:'a',id:'42',icons:[]}),'unknown');
});
test('one bulk request per page, log counts confirmed locks and skips already locked',async()=>{
  const {run} = api(), calls=[],messages=[];
  const locked=new Set(['2']);
  const card=(id,icons=['fa-unlock'])=>({rank:'a',id,icons});
  const result=await run({readPage:async p=>({cards:(p===1?['1','2','3']:['1','4']).map(id=>card(id,[locked.has(id)?'fa-lock':'fa-unlock'])),next:p===1}),
    lockPage:async ids=>{calls.push(ids);ids.forEach(id=>locked.add(id));return {status:'ok'};},sleep:async ms=>assert.equal(ms,1500),stopped:()=>false,log:x=>messages.push(x)});
  assert.deepEqual(calls,[['1','3'],['4']]);assert.equal(result.locked,3);assert.equal(result.already,1);assert.equal(result.checked,4);
  assert.ok(messages.some(x=>x.includes('Страница 2: новых блокировок 1')));
});
test('uncertain response stops immediately, records error and never retries',async()=>{
  const {run} = api(),calls=[];
  const result=await run({readPage:async()=>({cards:[{rank:'a',id:'1',icons:['fa-unlock']},{rank:'a',id:'2',icons:['fa-unlock']}],next:false}),
    lockPage:async ids=>{calls.push(ids);throw new Error('timeout');},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.deepEqual(calls,[['1','2']]);assert.equal(result.locked,0);assert.equal(result.errors,1);assert.equal(result.status,'error');
});
test('success response without changed locks is not counted; stop prevents any POST',async()=>{
  const {run} = api();
  const deps={readPage:async()=>({cards:[{rank:'a',id:'1',icons:['fa-unlock']}],next:false}),lockPage:async()=>({status:'ok'}),sleep:async()=>{},stopped:()=>false,log:()=>{}};
  const failed=await run(deps);assert.equal(failed.locked,0);assert.equal(failed.status,'error');
  const stopped=await run({...deps,stopped:()=>true,lockPage:()=>assert.fail('must not write')});
  assert.equal(stopped.status,'stopped');
});
test('partial page confirmation counts only confirmed IDs then stops',async()=>{
  const {run}=api();let posted=false,posts=0;
  const result=await run({readPage:async()=>({cards:['1','2'].map(id=>({id,rank:'a',icons:[posted&&id==='1'?'fa-lock':'fa-unlock']})),next:true}),
    lockPage:async()=>{posted=true;posts++;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(result.locked,1);assert.equal(result.errors,1);assert.equal(posts,1);
});
test('all 76 pages are processed with one bulk request each',async()=>{
  const {run}=api(),closed=new Set();let requests=0;
  const result=await run({readPage:async p=>({cards:[{id:String(p),rank:'a',icons:[closed.has(String(p))?'fa-lock':'fa-unlock']}],next:p<76}),
    lockPage:async ids=>{requests++;ids.forEach(id=>closed.add(id));return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(requests,76);assert.equal(result.pages,76);assert.equal(result.locked,76);assert.equal(result.status,'done');
});
test('stopping during bulk POST verifies its result but does not start next page',async()=>{
  const {run}=api();let stop=false,reads=0,posts=0;
  const result=await run({readPage:async()=>{reads++;return {cards:[{id:'1',rank:'a',icons:[stop?'fa-lock':'fa-unlock']}],next:true};},
    lockPage:async()=>{posts++;stop=true;return {};},sleep:async()=>{},stopped:()=>stop,log:()=>{}});
  assert.equal(result.locked,1);assert.equal(result.status,'stopped');assert.equal(reads,2);assert.equal(posts,1);
});
test('wrong-rank fallback page cannot claim a successful empty run',async()=>{
  const {run}=api();
  const result=await run({readPage:async()=>({cards:[{id:'1',rank:'b',icons:['fa-unlock']}],next:false}),
    lockPage:()=>assert.fail('must not write'),sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(result.status,'error');
});
test('unlocked mode drains 76 shrinking batches, always requesting page one',async()=>{
  const {run}=api();let remaining=Array.from({length:76},(_,i)=>String(i+1));const posts=[];
  const result=await run({mode:'unlocked',readPage:async page=>{
    assert.equal(page,1);return {cards:remaining.slice(0,1).map(id=>({id,rank:'a',icons:['fa-unlock']})),empty:!remaining.length,next:remaining.length>1};
  },lockPage:async ids=>{posts.push(ids);remaining=remaining.filter(id=>!ids.includes(id));return {status:'ok'};},
    sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(result.status,'done');assert.equal(result.locked,76);assert.equal(posts.length,76);
});
test('unlocked mode refuses stagnant first page without retrying POST',async()=>{
  const {run}=api();let posts=0;
  const result=await run({mode:'unlocked',readPage:async()=>({cards:[{id:'1',rank:'a',icons:['fa-unlock']}],next:true}),
    lockPage:async()=>{posts++;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(result.status,'error');assert.equal(result.locked,0);assert.equal(posts,1);
});
test('unlocked mode accepts only explicitly validated empty result',async()=>{
  const {run}=api();
  const deps={mode:'unlocked',lockPage:()=>assert.fail('no POST'),sleep:async()=>{},stopped:()=>false,log:()=>{}};
  assert.equal((await run({...deps,readPage:async()=>({cards:[],empty:true,next:false})})).status,'done');
  assert.equal((await run({...deps,readPage:async()=>({cards:[],next:false})})).status,'error');
});
test('malformed unlocked verification never inflates confirmed count',async()=>{
  const {run}=api();
  for(const invalid of [{rank:'a',id:null,icons:[]},{rank:'a',id:'2',icons:[]},{rank:'b',id:'2',icons:['fa-unlock']}]) {
    let reads=0;
    const result=await run({mode:'unlocked',readPage:async()=>({cards:[++reads===1?{rank:'a',id:'1',icons:['fa-unlock']}:invalid],next:false}),
      lockPage:async()=>({status:'ok'}),sleep:async()=>{},stopped:()=>false,log:()=>{}});
    assert.equal(result.locked,0);assert.equal(result.status,'error');
  }
});
function memoryLedger() {
  const {createLedger}=api();const values={};
  const storage={getItem:k=>values[k] || null,setItem:(k,v)=>{values[k]=v;}};
  return {ledger:createLedger(storage,'test'),storage,values};
}
test('ledger survives reload but exposes only confirmed bookmark locks',()=>{
  const {createLedger}=api(),{ledger,storage}=memoryLedger();
  ledger.set(['1','2'],'pending');ledger.set(['1'],'confirmed');
  assert.deepEqual(createLedger(storage,'test').confirmed(),['1']);
  ledger.set(['1'],'releasing');assert.deepEqual(ledger.confirmed(),[]);
});
test('lock records intent before POST and confirms only verified IDs',async()=>{
  const {run}=api(),{ledger}=memoryLedger();let posted=false;
  const result=await run({readPage:async()=>({cards:[{id:'1',rank:'a',icons:[posted?'fa-lock':'fa-unlock']}],next:false}),
    beforeLock:ids=>ledger.set(ids,'pending'),rememberLocked:ids=>ledger.set(ids,'confirmed'),
    lockPage:async()=>{assert.deepEqual(ledger.confirmed(),[]);posted=true;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(result.locked,1);assert.deepEqual(ledger.confirmed(),['1']);
});
test('failed journal write prevents locking cards',async()=>{
  const {run}=api();let posts=0;
  const result=await run({readPage:async()=>({cards:[{id:'1',rank:'a',icons:['fa-unlock']}],next:false}),
    beforeLock:()=>{throw new Error('quota');},lockPage:async()=>{posts++;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(posts,0);assert.equal(result.status,'error');
});
test('unlock touches only confirmed bookmark A locks, never manual, pending or A+',async()=>{
  const {runUnlock}=api(),{ledger}=memoryLedger();ledger.set(['1','3'],'confirmed');ledger.set(['4'],'pending');
  let posted=false;const calls=[];
  const result=await runUnlock({ledger,readPage:async()=>({cards:['1','2','3','4'].map(id=>({id,rank:id==='3'?'a_plus':'a',icons:[posted&&id==='1'?'fa-unlock':'fa-lock']})),next:false}),
    unlockPage:async ids=>{calls.push(ids);posted=true;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.deepEqual(calls,[['1']]);assert.equal(result.unlocked,1);assert.deepEqual(ledger.confirmed(),['3']);
});
test('unknown unlock response quarantines IDs and is never retried',async()=>{
  const {runUnlock}=api(),{ledger}=memoryLedger();ledger.set(['1'],'confirmed');let posts=0;
  const deps={ledger,readPage:async()=>({cards:[{id:'1',rank:'a',icons:['fa-lock']}],next:false}),
    unlockPage:async()=>{posts++;throw new Error('timeout');},sleep:async()=>{},stopped:()=>false,log:()=>{}};
  assert.equal((await runUnlock(deps)).status,'error');
  await runUnlock(deps);assert.equal(posts,1);assert.deepEqual(ledger.confirmed(),[]);
});
test('storage failure before unlock prevents every POST',async()=>{
  const {runUnlock}=api();let posts=0;
  const result=await runUnlock({ledger:{confirmed:()=>['1'],set:()=>{throw new Error('quota');}},
    readPage:async()=>({cards:[{id:'1',rank:'a',icons:['fa-lock']}],next:false}),
    unlockPage:async()=>{posts++;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(posts,0);assert.equal(result.status,'error');
});
test('partial unlock counts only verified IDs and retains uncertain IDs as releasing',async()=>{
  const {runUnlock}=api(),{ledger,values}=memoryLedger();ledger.set(['1','2'],'confirmed');let posted=false;
  const result=await runUnlock({ledger,readPage:async()=>({cards:['1','2'].map(id=>({id,rank:'a',icons:[posted&&id==='1'?'fa-unlock':'fa-lock']})),next:false}),
    unlockPage:async()=>{posted=true;return {};},sleep:async()=>{},stopped:()=>false,log:()=>{}});
  assert.equal(result.unlocked,1);assert.equal(result.status,'error');assert.deepEqual(JSON.parse(values.test),{'2':'releasing'});
});
