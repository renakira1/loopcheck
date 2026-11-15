import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairPlan, blendAt, repairedAudio, quietEdges } from '../repair.mjs';
function makeBuffer({length,numberOfChannels=1,sampleRate=1000}) {
  const data = Array.from({length:numberOfChannels},()=>new Float32Array(length));
  return {length,numberOfChannels,sampleRate,duration:length/sampleRate,getChannelData:c=>data[c]};
}
test('shared repair timeline consumes the opening once and blends the ending back into it', () => {
  const plan=repairPlan(10,1000,1,.2,.3);
  assert.equal(plan.duration,8.5);
  assert.equal(blendAt(plan,0).first,1.2);
  assert.ok(Math.abs(blendAt(plan,7.5).second-.2)<1e-12);
  const end=blendAt(plan,plan.duration);
  assert.ok(Math.abs(end.second-1.2)<1e-12);
  assert.equal(end.mix,1);
  assert.equal(end.first,9.7);
  assert.equal(repairPlan(1,1000,100).overlap,.5);
  assert.equal(repairPlan(1,1000,0).duration,1);
});
test('zero overlap keeps audio unchanged; trimming and overlap use identical sample boundaries', () => {
  const audio=makeBuffer({length:10,sampleRate:10});
  audio.getChannelData(0).set([.1,.2,.3,.4,.5,.6,.7,.8,.9,1]);
  const unchanged=repairedAudio(audio,repairPlan(1,10,0),'linear',makeBuffer);
  assert.deepEqual(unchanged.buffer.getChannelData(0),audio.getChannelData(0));
  const plan=repairPlan(1,10,.2,.1,.1);
  const repaired=repairedAudio(audio,plan,'linear',makeBuffer).buffer;
  assert.equal(repaired.length,6);
  assert.equal(repaired.duration,plan.duration);
  const expected=[.4,.5,.6,.7,.8,.6];
  repaired.getChannelData(0).forEach((sample,i)=>assert.ok(Math.abs(sample-expected[i])<1e-6));
});
test('quiet detection considers every channel and does not trim entirely quiet audio', () => {
  const audio=makeBuffer({length:100,numberOfChannels:2});
  audio.getChannelData(1)[20]=.1;
  audio.getChannelData(0)[79]=.1;
  assert.deepEqual(quietEdges(audio),{leading:.02,trailing:.02,allQuiet:false});
  assert.deepEqual(quietEdges(makeBuffer({length:100})),{leading:0,trailing:0,allQuiet:true});
});
test('audio crossfade softens a hard step across wrap without clipping', () => {
  const audio=makeBuffer({length:1000});
  audio.getChannelData(0).fill(-.8,0,500); audio.getChannelData(0).fill(.8,500);
  const result=repairedAudio(audio,repairPlan(1,1000,.2),'equal-power',makeBuffer);
  const pcm=result.buffer.getChannelData(0);
  assert.ok(Math.abs(pcm.at(-1)-pcm[0])<.01,'seam step is softened from 1.6 to <.01');
  const correlated=makeBuffer({length:1000}); correlated.getChannelData(0).fill(.99);
  const normalized=repairedAudio(correlated,repairPlan(1,1000,.2),'equal-power',makeBuffer);
  assert.ok(normalized.gain<1);
  assert.ok(Math.max(...normalized.buffer.getChannelData(0))<=1);
  assert.equal(normalized.buffer.length,800);
});

test('export includes short and low-frame-rate dissolves without changing loop duration', async () => {
  const {exportFrameTimes}=await import('../export-timeline.mjs');
  for (const [duration,rate,overlap] of [[3,1,.25],[1,24,.01],[5,30,1],[1,60,.0001]]) {
    const plan=repairPlan(duration,48000,overlap);
    const times=exportFrameTimes(plan,rate);
    assert.equal(times[0],0);
    assert.ok(times.every((time,i)=>time<plan.duration && (i===0 || time>times[i-1])));
    const blends=times.map(time=>blendAt(plan,time)).filter(blend=>blend.mix>0 && blend.mix<1);
    assert.ok(blends.length>=3,`${duration}s @${rate}fps, ${overlap}s overlap has interior blend samples`);
    const lengths=times.map((time,i)=>(times[i+1]??plan.duration)-time);
    assert.ok(lengths.every(length=>length>0));
    assert.ok(Math.abs(lengths.reduce((sum,length)=>sum+length,0)-plan.duration)<1e-12);
  }
  assert.deepEqual(exportFrameTimes(repairPlan(1,48000,0),4),[0,.25,.5,.75]);
});
