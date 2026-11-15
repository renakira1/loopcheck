import { chromium } from 'playwright-core';
import { auditRegressions, exportStallRegressions } from './audit-regressions.mjs';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const temp = await mkdtemp(resolve(tmpdir(), 'loopcheck-test-'));
const fixture = resolve(temp, 'test.mp4');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',fixture]);
const gappedFixture = resolve(temp, 'gapped.mp4');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',gappedFixture]);
const largeFixture = resolve(temp, 'large.mp4');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1440x810:rate=12:duration=0.5','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',largeFixture]);
const silentFixture = resolve(temp, 'silent.mp4');
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-i',fixture,'-c:v','copy','-an','-y',silentFixture]);
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    const data = await readFile(path);
    res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(path)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try {
  const page = await browser.newPage();
  const errors = [];

  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#export-quality').selectOption('standard',{force:true});
  await page.locator('#file').setInputFiles(fixture);
  await page.waitForFunction(() => !document.querySelector('#play').disabled, {timeout:20000});
  console.log('Prepared:', await page.locator('#quality').textContent());
  assert.match(await page.locator('#quality').textContent(), /24 frames cached.*audio cached/);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#play').textContent === 'Pause');
  // Sample real canvas changes across several 1s loops. Wall time here is intentional playback testing.
  const colors = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas'); const ctx = canvas.getContext('2d'); const samples=[];
    for (let i=0;i<15;i++) { await new Promise(r=>setTimeout(r,150)); const data=ctx.getImageData(0,0,canvas.width,canvas.height).data; let hash=0; for(let n=0;n<data.length;n+=127) hash=(hash*31+data[n])|0; samples.push(hash); }
    return samples;
  });
  assert.ok(new Set(colors).size > 8, 'canvas presents changing cached frames across multiple loops');
  await page.locator('#mute').click();
  assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'true');
  await page.locator('#play').click();
  assert.equal(await page.locator('#play').textContent(), 'Play');
  // Offline render proves no inserted samples at the audio boundary, independent of audio hardware.
  const pcmResult = await page.evaluate(async () => {
    const {LoopTransport} = await import('./loop-engine.mjs');
    const ctx = new OfflineAudioContext(1, 4800, 48000);
    const gain = ctx.createGain(); gain.connect(ctx.destination);
    const buffer=ctx.createBuffer(1,100,48000);
    for(let n=0;n<100;n++) buffer.getChannelData(0)[n]=(n+1)/100;
    const transport=new LoopTransport(ctx,gain);
    transport.configure(100/48000,buffer); transport.start();
    const rendered=await ctx.startRendering(); const data=rendered.getChannelData(0);
    let maxError=0;
    for(let n=2400;n<4800;n++) maxError=Math.max(maxError,Math.abs(data[n]-buffer.getChannelData(0)[(n-2400)%100]));
    return maxError;
  });
  assert.ok(pcmResult < 1e-6, `continuous PCM loop error: ${pcmResult}`);
  console.log('Offline audio: 24 loop periods, no inserted silence; maximum sample error:', pcmResult);
  await page.locator('#file').setInputFiles({name:'broken.mp4',mimeType:'video/mp4',buffer:Buffer.from('broken')});
  await page.waitForFunction(() => document.querySelector('#loading').hidden);
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#file').setInputFiles(fixture);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout fits');
  await page.locator('#file').setInputFiles(silentFixture);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.match(await page.locator('#quality').textContent(), /no audio track/);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#play').textContent === 'Pause');
  await page.locator('#play').click();
  // Rapid replacement must cancel old work and leave the latest clip usable.
  await page.locator('#file').setInputFiles(fixture);
  await page.locator('#file').setInputFiles(silentFixture);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.match(await page.locator('#quality').textContent(), /no audio track/);
  await page.locator('#file').setInputFiles(gappedFixture);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  console.log('Gap diagnosis:', await page.locator('#audio-diagnostic').textContent());
  assert.match(await page.locator('#audio-diagnostic').textContent(), /padded with silence/);
  await page.locator('#trim-silence').check();
  assert.match(await page.locator('#repair-info').textContent(), /Quiet-edge removal/);
  const repairedDuration = await page.locator('#duration').textContent();
  await page.locator('#original').click();
  assert.match(await page.locator('#duration').textContent(), /2.00s · original/);
  await page.locator('#repaired').click();
  assert.equal(await page.locator('#duration').textContent(), repairedDuration);
  await page.locator('#export').click();
  try {
    await page.waitForFunction(() => !document.querySelector('#download').hidden, null, {timeout:60000});
  } catch (error) { throw new Error(`${error.message}; status: ${await page.locator('#export-status').textContent()}`); }
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloadEvent;
  const exported = resolve(temp, download.suggestedFilename());
  await download.saveAs(exported);
  const probe = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',exported], {encoding:'utf8'}));
  assert.equal(probe.streams.find(stream=>stream.codec_type==='video').width,320);
  assert.ok(probe.streams.find(stream=>stream.codec_type==='audio'));
  assert.ok(Number(probe.format.duration)<1.65 && Number(probe.format.duration)>1.45, 'export is shortened by quiet edges and overlap');
  const pcm = execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',exported,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);
  let trailing=0;
  for (let i=pcm.length-4;i>=0 && Math.abs(pcm.readFloatLE(i))<.001;i-=4) trailing++;
  assert.ok(trailing/48000<.03, `export has no original 200ms tail gap: ${trailing/48000}s quiet tail`);
  console.log('Export verified:', download.suggestedFilename(), probe.format.duration, 'seconds; trailing quiet:', trailing/48000, 'seconds');
  await page.evaluate(async data => { window.testExport=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'export.webm'); }, (await readFile(exported)).toString('base64'));
  // Reopen the actual encoded result; the original mode must show the repaired file itself.
  await page.locator('#file').setInputFiles(exported);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  await page.locator('#original').click();
  assert.match(await page.locator('#quality').textContent(), /audio cached/);
  const encodedTimeline = await page.evaluate(async () => {
    const {Input,BlobSource,ALL_FORMATS,AudioBufferSink}=await import('./vendor/mediabunny-1.66.0.min.mjs');
    const input=new Input({source:new BlobSource(document.querySelector('#file').files[0] || window.testExport),formats:ALL_FORMATS});
    const track=await input.getPrimaryAudioTrack(); const video=await input.getPrimaryVideoTrack(); let first,last,count=0;
    for await(const chunk of new AudioBufferSink(track).buffers()){ first ??= chunk.timestamp; last=chunk.timestamp+chunk.buffer.duration; count+=chunk.buffer.length; }
    const result={end:await input.computeDuration(),audioEnd:await track.computeDuration(),videoEnd:await video.computeDuration(),first,last,count}; input.dispose(); return result;
  });
  assert.ok(encodedTimeline.end - encodedTimeline.last < .005, 'reopening export must not add an artificial silent tail');
  console.log('Encoded timeline:', encodedTimeline);
  console.log('Reopened encoded result:', await page.locator('#audio-diagnostic').textContent());
  const blendPixel = await page.evaluate(async () => {
    const {paintPreview,repairPlan}=await import('./repair.mjs');
    const red=document.createElement('canvas'); red.width=red.height=2;
    const blue=document.createElement('canvas'); blue.width=blue.height=2;
    const target=document.createElement('canvas'); target.width=target.height=2;
    red.getContext('2d').fillStyle='red';red.getContext('2d').fillRect(0,0,2,2);
    blue.getContext('2d').fillStyle='blue';blue.getContext('2d').fillRect(0,0,2,2);
    paintPreview(target.getContext('2d'),[{timestamp:0,image:red},{timestamp:.5,image:blue}],repairPlan(1,1000,.2),.7,2,2);
    return [...target.getContext('2d').getImageData(0,0,1,1).data];
  });
  assert.ok(Math.abs(blendPixel[0]-128)<=2 && Math.abs(blendPixel[2]-128)<=2 && blendPixel[3]===255, `midpoint is a full-opacity visual blend: ${blendPixel}`);
  // Full-resolution silent export also exercises MP4/H.264 when AAC is unavailable.
  await page.locator('#file').setInputFiles(largeFixture);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.match(await page.locator('#quality').textContent(), /1280 × 720 preview/);
  await page.locator('#export').click();
  await page.waitForFunction(() => !document.querySelector('#download').hidden, null, {timeout:60000});
  const fullDownloadEvent = page.waitForEvent('download');
  await page.locator('#download').click();
  const fullDownload=await fullDownloadEvent;
  const fullExported=resolve(temp,fullDownload.suggestedFilename());
  await fullDownload.saveAs(fullExported);
  const fullProbe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',fullExported],{encoding:'utf8'}));
  assert.equal(fullProbe.streams[0].width,1440);
  assert.equal(fullProbe.streams[0].height,810);
  assert.equal(fullProbe.streams.length,1);
  console.log('Full-resolution export verified:', fullDownload.suggestedFilename(), '1440 × 810 from a 1280 × 720 preview');
  // Cancelling must release busy controls and leave the loaded clip usable.
  await page.evaluate(() => { document.querySelector('#export').click(); document.querySelector('#cancel-export').click(); });
  await page.waitForFunction(() => !document.querySelector('#export').disabled);
  assert.match(await page.locator('#export-status').textContent(), /cancelled/);
  await auditRegressions({browser,url:`http://127.0.0.1:${server.address().port}`,temp,fixture});
  await exportStallRegressions({browser,url:`http://127.0.0.1:${server.address().port}`,temp,fixture:largeFixture});
  assert.deepEqual(errors, []);
  console.log('Passed real MP4/AAC decoding, canvas playback over loop boundaries, controls, error recovery, mobile-width layout, and PCM boundary render.');
} finally { await browser.close(); server.close(); await rm(temp, {recursive:true,force:true}); }
