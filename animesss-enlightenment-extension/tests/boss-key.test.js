const test = require('node:test');
const assert = require('node:assert/strict');
const {createBossKeyRepeater} = require('../boss-key.js');

test('boss S repeats at 50 ms, pauses for typing, and stops on context loss',() => {
  const events = [], removed = [];
  let callback, connected = true, starts = 0;
  const doc = {hidden:false,activeElement:null,dispatchEvent:e=>events.push(e)};
  class KeyEvent { constructor(type,options) { Object.assign(this,{type},options); } }
  const control = createBossKeyRepeater({doc,KeyboardEventClass:KeyEvent,isConnected:()=>connected,
    setInterval:(fn,ms)=>{assert.equal(ms,50);callback=fn;return ++starts;},clearInterval:id=>removed.push(id)});
  assert.equal(control.running,false);
  control.start(); control.start();
  assert.equal(starts,1);
  assert.deepEqual(events.map(e=>e.type),['keydown','keypress','keyup']);
  assert.ok(events.every(e=>e.key==='s'&&e.code==='KeyS'&&e.which===83&&e.bubbles));
  callback(); assert.equal(events.length,6);
  doc.activeElement={tagName:'INPUT'};callback();assert.equal(events.length,6);
  doc.activeElement={isContentEditable:true};callback();assert.equal(events.length,6);
  doc.activeElement=null;callback();assert.equal(events.length,9);
  connected=false;callback();assert.equal(events.length,9);assert.equal(control.running,false);
  assert.deepEqual(removed,[1]);
  connected=true;control.start();control.stop();assert.equal(control.running,false);
  const count=events.length;
  doc.hidden=true;control.start();assert.equal(events.length,count);
});
