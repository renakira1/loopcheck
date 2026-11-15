import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportStep,SequentialFrameReader} from '../export-runtime.mjs';

test('codec waits fail with a stage-specific deadline instead of hanging',async()=>{
  await assert.rejects(exportStep(()=>new Promise(()=>{}),{timeoutMs:10,label:'Encoding frame 32/300'}),/Encoding frame 32\/300 stopped responding/);
});
test('Cancel interrupts a never-resolving codec wait',async()=>{
  const controller=new AbortController();
  const wait=exportStep(()=>new Promise(()=>{}),{signal:controller.signal,timeoutMs:1000});
  controller.abort();
  await assert.rejects(wait,error=>error.name==='AbortError');
  let called=false;
  await assert.rejects(exportStep(()=>{called=true;},{signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(called,false);
});
test('sequential reader preserves timestamps, lookahead, final holds, and sample cleanup',async()=>{
  const samples=[0,.1,.2].map(timestamp=>({timestamp,displayWidth:100,displayHeight:50,draw(){this.drawn=true;},close(){this.closed=true;}}));
  let index=0,returned=false;
  const iterator={async next(){return index<samples.length?{value:samples[index++],done:false}:{done:true};},async return(){returned=true;return {done:true};}};
  const canvas={width:200,height:100,getContext:()=>({fillRect(){}})};
  const reader=new SequentialFrameReader(iterator,canvas);
  assert.equal(await reader.at(-.01),null);
  assert.equal(await reader.at(.05),canvas);
  assert.equal(samples[0].closed,true);
  assert.equal(samples[1].drawn,undefined);
  await reader.at(.1);
  assert.equal(samples[1].drawn,true);
  assert.equal(samples[1].closed,true);
  assert.equal(await reader.at(10),canvas);
  await reader.close();
  assert.ok(samples.every(sample=>sample.closed));
  assert.equal(returned,true);
});

test('lossless has no bitrate fallback and invalid quality modes are rejected',async()=>{
  const {encodingQuality}=await import('../encoding-quality.mjs');
  assert.deepEqual(encodingQuality('lossless',720,1280,24),{quantizer:0});
  assert.ok(encodingQuality('high',720,1280,24).bitrate>encodingQuality('standard',720,1280,24).bitrate);
  assert.throws(()=>encodingQuality('unknown',720,1280,24),/Unknown export quality/);
});
