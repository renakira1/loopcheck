import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await mkdtemp(resolve(tmpdir(),'loopcheck-lossless-'));
let file=process.env.LOOPCHECK_VIDEO;
if(!file){
  file=resolve(temp,'texture.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1','-f','lavfi','-i','sine=sample_rate=48000:duration=1','-ac','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',file]);
}
const sourceInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));
const sourceVideo=sourceInfo.streams.find(s=>s.codec_type==='video');
const server=createServer(async(req,res)=>{try{
  const url=req.url.split('?')[0],path=resolve(root,'.'+(url==='/'?'/index.html':url));
  if(!path.startsWith(root)){res.writeHead(403).end();return;}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));
}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#file').setInputFiles(file);
  await page.waitForFunction(()=>!document.querySelector('#play').disabled);
  assert.equal(await page.locator('#export-quality').inputValue(),'lossless');
  assert.equal(await page.locator('#export-size').inputValue(),'original');
  await page.locator('#export').click();
  await page.waitForFunction(()=>!document.querySelector('#export').disabled,null,{timeout:60000});
  assert.equal(await page.locator('#download').isVisible(),true,await page.locator('#export-status').textContent());
  const event=page.waitForEvent('download');await page.locator('#download').click();const download=await event;
  assert.match(download.suggestedFilename(),/\.mkv$/);
  const output=resolve(temp,'lossless.mkv');await download.saveAs(output);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
  const video=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.find(s=>s.codec_type==='audio');
  assert.equal(video.width,sourceVideo.width);assert.equal(video.height,sourceVideo.height);
  assert.equal(video.codec_name,'vp9');assert.equal(audio.codec_name,'pcm_f32le');
  const trace=spawnSync('ffmpeg',['-hide_banner','-loglevel','info','-i',output,'-map','0:v:0','-c','copy','-bsf:v','trace_headers','-f','null','-'],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(trace.status,0);
  const quantizers=[...trace.stderr.matchAll(/base_q_idx\s+[01]+\s*=\s*(\d+)/g)].map(m=>Number(m[1]));
  assert.ok(quantizers.length>0 && quantizers.every(q=>q===0),'all encoded VP9 frames have quantizer zero');
  const deltas=[...trace.stderr.matchAll(/delta_q_\w+\.delta_coded\s+[01]+\s*=\s*(\d+)/g)].map(m=>Number(m[1]));
  assert.ok(deltas.length>0 && deltas.every(q=>q===0),'no nonzero plane quantization deltas');
  // Reduced-size summaries must report reduced dimensions rather than advertise
  // the original dimensions, and returning to lossless resets to original size.
  await page.locator('#export-quality').selectOption('standard');
  await page.locator('#export-size').selectOption('preview');
  const expected=await page.locator('#video').evaluate(c=>`${Math.ceil(c.width/2)*2} × ${Math.ceil(c.height/2)*2}`);
  assert.ok((await page.locator('#export-spec').textContent()).includes(expected));
  assert.match(await page.locator('#export-spec').textContent(),/Reduced resolution|Cached preview at source dimensions/);
  await page.locator('#export-quality').selectOption('lossless');
  assert.equal(await page.locator('#export-size').inputValue(),'original');
  await page.locator('#file').setInputFiles(output);
  await page.waitForFunction(()=>!document.querySelector('#play').disabled);
  assert.match(await page.locator('#quality').textContent(),/audio cached/);
  // A browser without strict lossless support must not silently choose bitrate
  // encoding, MP4, or a reduced-size output.
  await page.evaluate(()=>{VideoEncoder.isConfigSupported=async config=>({supported:false,config});});
  await page.locator('#export').click();
  await page.waitForFunction(()=>!document.querySelector('#export').disabled);
  assert.equal(await page.locator('#download').isVisible(),false);
  assert.match(await page.locator('#export-status').textContent(),/Lossless export failed; no lossy fallback/);
  assert.deepEqual(errors,[]);
  console.log(`Verified lossless VP9 on every encoded frame, float PCM audio, ${video.width} × ${video.height}, strict unsupported-mode error, and accurate size summaries.`);
}finally{await browser?.close();server.close();await rm(temp,{recursive:true,force:true});}
