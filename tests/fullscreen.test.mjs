import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    const path = resolve(root, '.' + (url === '/' ? '/index.html' : url));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    const data = await readFile(path);
    res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[extname(path)] || 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
const temp=await mkdtemp(resolve(tmpdir(),'loopcheck-fullscreen-'));
const fixture=resolve(temp,'test.mp4');
try {
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=0.25','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',fixture]);
  browser = await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));

  // A thick red frame marks all four source edges; blue marks its center.
  async function setVideo(width,height) {
    await page.evaluate(({width,height})=>{
      const canvas=document.querySelector('#video');canvas.width=width;canvas.height=height;canvas.hidden=false;
      document.querySelector('#empty').hidden=true;document.querySelector('#controls').hidden=false;
      const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,width,height);
      ctx.fillStyle='rgb(20,40,80)';ctx.fillRect(20,20,width-40,height-40);
      window.dispatchEvent(new Event('resize'));
    },{width,height});
  }
  async function assertFit(label) {
    await page.waitForFunction(()=>{
      const c=document.querySelector('#video'),r=c.getBoundingClientRect();
      const s=Math.min(innerWidth/c.width,innerHeight/c.height);
      return Math.abs(r.width-c.width*s)<1 && Math.abs(r.height-c.height*s)<1;
    });
    const state=await page.evaluate(()=>{
      const canvas=document.querySelector('#video');const rect=canvas.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],box:[rect.x,rect.y,rect.width,rect.height],source:[canvas.width,canvas.height],fit:getComputedStyle(canvas).objectFit};
    });
    assert.equal(state.fit,'contain');
    assert.ok(state.box[0]>=-1 && state.box[1]>=-1 && state.box[2]<=state.viewport[0]+1 && state.box[3]<=state.viewport[1]+1,`${label}: canvas stays inside viewport: ${JSON.stringify(state)}`);
    const expectedScale=Math.min(state.viewport[0]/state.source[0],state.viewport[1]/state.source[1]);
    assert.ok(Math.abs(state.box[2]-state.source[0]*expectedScale)<1 && Math.abs(state.box[3]-state.source[1]*expectedScale)<1, `${label}: canvas fits without changing aspect ratio`);
    const shot=await page.screenshot();
    const width=shot.readUInt32BE(16),height=shot.readUInt32BE(20);
    const pixels=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-f','rawvideo','-pix_fmt','rgb24','-threads','1','pipe:1'],{input:shot,maxBuffer:32*1024*1024});
    const scale=Math.min(width/state.source[0],height/state.source[1]);
    const fitWidth=state.source[0]*scale,fitHeight=state.source[1]*scale;
    const left=(width-fitWidth)/2,top=(height-fitHeight)/2,inset=10*scale;
    const pixel=(x,y)=>[...pixels.subarray((Math.floor(y)*width+Math.floor(x))*3,(Math.floor(y)*width+Math.floor(x))*3+3)];
    for(const [x,y] of [[left+inset,height/2],[left+fitWidth-inset,height/2],[width/2,top+inset],[width/2,top+fitHeight-inset]]) {
      const rgb=pixel(x,y);
      assert.ok(rgb[0]>230 && rgb[1]<25 && rgb[2]<25,`${label}: source edge must remain visible at ${x},${y}, got ${rgb}`);
    }
    const center=pixel(width/2,height/2);
    assert.ok(Math.abs(center[0]-20)<3 && Math.abs(center[1]-40)<3 && Math.abs(center[2]-80)<3,`${label}: video center remains visible`);
    console.log('Fit verified:',label);
  }
  for (const staleCss of [false,true]) {
  await page.unroute('**/styles.css*');
  if (staleCss) {
    const current=await readFile(resolve(root,'styles.css'),'utf8');
    const legacy=current.slice(0,current.indexOf('/* Explicit'))+current.slice(current.indexOf('details a'))+
      '.stage:fullscreen canvas,.stage.expanded canvas{max-height:100%;height:100%;object-fit:contain}.stage.expanded{position:fixed;inset:0;z-index:10}';
    await page.route('**/styles.css*', route=>route.fulfill({status:200,contentType:'text/css',body:legacy}));
  }
  await page.setViewportSize({width:1280,height:720});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('#exit-fullscreen').isVisible(),false,'exit hidden before loading a clip');
  await page.locator('#file').setInputFiles(fixture);
  await page.waitForFunction(()=>!document.querySelector('#play').disabled);
  assert.equal(await page.locator('#exit-fullscreen').isVisible(),false,'exit hidden after decoding a real clip');
  await setVideo(1920,1080);
  console.log('Stylesheet scenario:',staleCss?'outdated stylesheet':'current stylesheet');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(()=>document.fullscreenElement!==null);
  await assertFit('native landscape video');
  await setVideo(1080,1920);
  await assertFit('native portrait video');
  await page.locator('#exit-fullscreen').click();
  await page.waitForFunction(()=>document.fullscreenElement===null);
  assert.equal(await page.locator('#fullscreen').textContent(),'Fullscreen');
  // Exercise mobile browsers without the element Fullscreen API.
  await page.evaluate(()=>{document.querySelector('#dropzone').requestFullscreen=undefined;});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#fullscreen').click();
  await assertFit('fallback portrait video on portrait phone');
  await setVideo(1920,1080);
  await assertFit('fallback landscape video on portrait phone');
  await page.setViewportSize({width:844,height:390});
  await assertFit('fallback after phone rotation');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dropzone').evaluate(el=>el.classList.contains('expanded')),false);
  assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'),'false');
  await page.locator('#fullscreen').click();
  await page.locator('#exit-fullscreen').click();
  assert.equal(await page.locator('#dropzone').evaluate(el=>el.classList.contains('expanded')),false);
  assert.equal(await page.locator('#exit-fullscreen').isVisible(),false,'exit hidden after leaving fullscreen');
  assert.equal(await page.locator('body').evaluate(el=>el.style.overflow),'');
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  server.close();
  await rm(temp,{recursive:true,force:true});
}
