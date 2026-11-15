import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await mkdtemp(resolve(tmpdir(),'loopcheck-windows-'));
let file=process.env.LOOPCHECK_VIDEO;
if(!file) {
  file=resolve(temp,'portrait.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=720x1280:rate=24:duration=3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3.029333','-ac','2','-c:v','libx264','-preset','fast','-threads','2','-pix_fmt','yuv420p','-bf','2','-c:a','aac','-y',file]);
}
const server=createServer(async(req,res)=>{
  try {
    const url=req.url.split('?')[0];const path=resolve(root,'.'+(url==='/'?'/index.html':url));
    if(!path.startsWith(root)){res.writeHead(403).end();return;}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');
    res.end(await readFile(path));
  }catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  for(const simulateStall of [false,true]) {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    if(simulateStall) {
      // Linux Chrome lacks AAC encoding. PCM exercises the real MP4/H.264
      // pipeline without pretending to verify the Windows AAC implementation.
      await page.route('**/export-video.mjs*',async route=>{
        const source=await readFile(resolve(root,'export-video.mjs'),'utf8');
        await route.fulfill({status:200,contentType:'text/javascript',body:source.replaceAll("'aac'","'pcm-s16'").replace('timeoutMs = 30000','timeoutMs = 1000')});
      });
      await page.addInitScript(()=>{
        const NativeEncoder=VideoEncoder;
        window.encoderConfigs=[];window.injectedStall=false;
        window.VideoEncoder=class extends NativeEncoder {
          configure(config){this.config=config;this.inputs=0;window.encoderConfigs.push({...config});super.configure(config);}
          encode(frame,options){
            if(this.config.codec.startsWith('avc1') && ++this.inputs>=9){window.injectedStall=true;return;}
            super.encode(frame,options);
          }
          get encodeQueueSize(){return this.config?.codec.startsWith('avc1') && this.inputs>=9 && this.state!=='closed'?4:super.encodeQueueSize;}
          addEventListener(type,listener,options){
            if(type==='dequeue')return super.addEventListener(type,event=>{
              if(!(this.config?.codec.startsWith('avc1') && this.inputs>=9))listener.call(this,event);
            },options);
            return super.addEventListener(type,listener,options);
          }
        };
      });
    }
    await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#export-quality').selectOption('standard',{force:true});
    await page.locator('#file').setInputFiles(file);
    await page.waitForFunction(()=>!document.querySelector('#play').disabled,null,{timeout:30000});
    await page.locator('#export').click();
    await page.waitForFunction(()=>!document.querySelector('#export').disabled,null,{timeout:45000});
    const status=await page.locator('#export-status').textContent();
    assert.equal(await page.locator('#download').isVisible(),true,status);
    if(simulateStall) {
      assert.equal(await page.evaluate(()=>window.injectedStall),true,'encoder stalls at frame 9');
      assert.match(status,/Used WebM after the MP4 encoder failed/);
      const configs=await page.evaluate(()=>window.encoderConfigs);
      assert.ok(configs.some(c=>c.codec.startsWith('avc1')));
      assert.ok(configs.some(c=>c.codec.startsWith('vp09')));
      assert.ok(configs.every(c=>c.hardwareAcceleration==='prefer-software' && c.latencyMode==='quality'));
    }
    const event=page.waitForEvent('download');await page.locator('#download').click();const download=await event;
    const output=resolve(temp,`${simulateStall?'recovered':'normal'}.webm`);await download.saveAs(output);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'}));
    assert.equal(info.streams.find(s=>s.codec_type==='video').width,720);
    assert.equal(info.streams.find(s=>s.codec_type==='video').height,1280);
    assert.equal(info.streams.find(s=>s.codec_type==='audio').channels,2);
    assert.ok(Math.abs(Number(info.format.duration)-2.78)<.05);
    // Decode every exported frame/audio packet, not just container metadata.
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',output,'-fps_mode','passthrough','-enc_time_base:v','1:1000000','-f','null','-']);
    assert.deepEqual(errors,[]);
    console.log(simulateStall?'Frame-9 H.264 stall recovered automatically to full-resolution WebM with stereo audio.':'Portrait input downloaded at 720 × 1280 with stereo audio.');
    await page.close();
  }
} finally {await browser?.close();server.close();await rm(temp,{recursive:true,force:true});}
