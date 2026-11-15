import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function auditRegressions({browser,url,temp,fixture}) {
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(url);
  await page.locator('#export-quality').selectOption('standard',{force:true});
    for (const [duration,rate,overlapMs] of [[3,1,250],[1,24,10]]) {
      const source=resolve(temp,`blend-${rate}.mp4`);
      const filter=`color=c=red:size=64x64:rate=${rate}:duration=${duration},drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,${duration/2})'`;
      execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',filter,'-c:v','libx264','-pix_fmt','yuv420p','-y',source]);
      await page.locator('#file').setInputFiles(source);
      await page.waitForFunction(()=>!document.querySelector('#play').disabled);
      await page.locator('#overlap').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input'));el.dispatchEvent(new Event('change'));},overlapMs);
      await page.locator('#export').click();
      await page.waitForFunction(()=>!document.querySelector('#export').disabled,null,{timeout:60000});
      assert.equal(await page.locator('#download').isVisible(),true,await page.locator('#export-status').textContent());
      const event=page.waitForEvent('download');await page.locator('#download').click();
      const download=await event;
      const output=resolve(temp,download.suggestedFilename());await download.saveAs(output);
      const rgb=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',output,'-fps_mode','passthrough','-enc_time_base:v','1:1000000','-f','rawvideo','-pix_fmt','rgb24','-threads','1','pipe:1']);
      const frameBytes=64*64*3,center=(32*64+32)*3;
      let blended=0;
      for(let offset=0;offset<rgb.length;offset+=frameBytes) {
        const pixel=rgb.subarray(offset+center,offset+center+3);
        if(pixel[0]>25 && pixel[2]>25 && pixel[1]<30) blended++;
      }
      assert.ok(blended>=3,`${rate}fps with ${overlapMs}ms blend must contain encoded mixed pixels, got ${blended}`);
      const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_frames','-select_streams','v:0','-of','json',output],{encoding:'utf8'}));
      const timestamps=info.frames.map(frame=>Number(frame.best_effort_timestamp_time));
      assert.ok(timestamps.every((time,i)=>i===0 || time>timestamps[i-1]),'encoded frame timestamps are strictly increasing');
      assert.ok(Math.abs(Number(info.format.duration)-(duration-overlapMs/1000))<.002,'export retains the repaired duration');
      console.log(`Encoded dissolve verified: ${rate}fps source, ${overlapMs}ms blend, ${blended} blended frames`);
    }
  } finally { await page.close(); }

  const race=await browser.newPage();
  race.on('pageerror',error=>errors.push(error.message));
  try {
    await race.addInitScript(()=>{
      window.resumeRequests=[];
      const resume=AudioContext.prototype.resume;
      AudioContext.prototype.resume=function() {
        let release,reject;
        const gate=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
        window.resumeRequests.push({release,reject});
        return resume.call(this).then(()=>gate);
      };
      const supports=VideoEncoder.isConfigSupported;
      VideoEncoder.isConfigSupported=async function(config) {
        if(window.holdEncoders) {
          window.encoderEntered=true;
          await new Promise(resolve=>{window.releaseEncoders=resolve;});
        }
        return supports.call(this,config);
      };
    });
    await race.goto(url);
  await race.locator('#export-quality').selectOption('standard',{force:true});
    await race.locator('#file').setInputFiles(fixture);
    await race.waitForFunction(()=>!document.querySelector('#play').disabled);
    async function settle(index,fail=false) {
      await race.evaluate(async ({index,fail})=>{
        const request=window.resumeRequests[index];
        if(fail) request.reject(new Error('stale resume error'));
        else request.release();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      },{index,fail});
    }
    async function startHeldExport() {
      await race.evaluate(()=>{window.holdEncoders=true;window.encoderEntered=false;});
      await race.locator('#play').click();
      assert.equal(await race.locator('#play').textContent(),'Starting…');
      await race.locator('#export').click();
      await race.waitForFunction(()=>window.encoderEntered);
    }
    async function cancelHeldExport() {
      await race.locator('#cancel-export').click();
      await race.evaluate(()=>{window.holdEncoders=false;window.releaseEncoders();});
      await race.waitForFunction(()=>!document.querySelector('#export').disabled);
    }
    // Pending playback must not resume either during export or after cancellation.
    await startHeldExport();
    await settle(0);
    assert.equal(await race.locator('#play').textContent(),'Play');
    assert.equal(await race.locator('#play').isDisabled(),true);
    assert.match(await race.locator('#export-status').textContent(),/Checking .*encoder/);
    await cancelHeldExport();
    await startHeldExport();
    await cancelHeldExport();
    await settle(1);
    assert.equal(await race.locator('#play').textContent(),'Play');
    // A version change invalidates even a rejected old request and its message.
    await race.locator('#play').click();
    await race.locator('#original').click();
    const ready=await race.locator('#message').textContent();
    await settle(2,true);
    assert.equal(await race.locator('#play').textContent(),'Play');
    assert.equal(await race.locator('#message').textContent(),ready);
    // Cancelling and restarting Play keeps only the latest request valid.
    await race.locator('#play').click();
    await race.locator('#play').click();
    await race.locator('#play').click();
    await settle(3);
    assert.equal(await race.locator('#play').textContent(),'Starting…');
    await settle(4);
    assert.equal(await race.locator('#play').textContent(),'Pause');
    await race.locator('#play').click();
    // A setting change cancels a pending request even though media identity stays.
    await race.locator('#play').click();
    await race.locator('#overlap').evaluate(el=>{el.value=100;el.dispatchEvent(new Event('change'));});
    await settle(5);
    assert.equal(await race.locator('#play').textContent(),'Play');
    // Hide then show before resume resolves: returning to the page must not revive it.
    await race.locator('#play').click();
    await race.evaluate(()=>{
      Object.defineProperty(document,'hidden',{value:true,configurable:true});
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    });
    await settle(6);
    assert.equal(await race.locator('#play').textContent(),'Play');
    console.log('Pending Play verified: export, cancellation, comparison, repeated Play, settings, and page visibility');
  } finally { await race.close(); }
  assert.deepEqual(errors,[]);
}

export async function exportStallRegressions({browser,url,temp,fixture}) {
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(url);
  await page.locator('#export-quality').selectOption('standard',{force:true});
    await page.locator('#file').setInputFiles(fixture);
    await page.waitForFunction(()=>!document.querySelector('#play').disabled);
    await page.evaluate(async()=>{
      const {VideoSampleSink}=await import('./vendor/mediabunny-1.66.0.min.mjs');
      const original=VideoSampleSink.prototype.samples;
      window.decodeCalls=0;
      VideoSampleSink.prototype.samples=function(...args) {
        const iterator=original.apply(this,args);
        return {
          next(){
            if(++window.decodeCalls===4){window.decoderBlocked=true;return new Promise(()=>{});}
            return iterator.next();
          },
          return(){window.readerReturned=true;return iterator.return();},
          [Symbol.asyncIterator](){return this;},
        };
      };
    });
    await page.locator('#export').click();
    await page.waitForFunction(()=>window.decoderBlocked);
    assert.match(await page.locator('#export-status').textContent(),/Decoding main frame/);
    await page.locator('#cancel-export').click();
    await page.waitForFunction(()=>!document.querySelector('#export').disabled,null,{timeout:3000});
    assert.match(await page.locator('#export-status').textContent(),/cancelled/);
    assert.equal(await page.evaluate(()=>window.readerReturned),true);
    const calls=await page.evaluate(()=>window.decodeCalls);
    await page.locator('#export-size').selectOption('preview');
    await page.locator('#export').click();
    await page.waitForFunction(()=>!document.querySelector('#export').disabled,null,{timeout:60000});
    assert.equal(await page.locator('#download').isVisible(),true,await page.locator('#export-status').textContent());
    assert.equal(await page.evaluate(()=>window.decodeCalls),calls,'smaller export uses cached frames, avoiding the blocked decoder');
    const event=page.waitForEvent('download');await page.locator('#download').click();
    const download=await event;
    const output=resolve(temp,`smaller-${download.suggestedFilename()}`);await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
    assert.equal(info.streams[0].width,1280);
    assert.equal(info.streams[0].height,720);
    assert.deepEqual(errors,[]);
    console.log('Export recovery verified: Cancel interrupts a stalled decoder; cached-preview download succeeds at 1280 × 720');
  } finally {await page.close();}
}
