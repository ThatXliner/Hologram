import assert from 'node:assert/strict';
import {readFileSync, existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const output = mkdtempSync(join(tmpdir(), 'hologram-native-races-'));
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.cache/**','**/scripts/**','**/crates/**','**/src-tauri/**']}}});
await server.listen();
const browser = await chromium.launch({headless:true,executablePath: [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
try {
 await page.addInitScript(() => {
  const pending: (()=>void)[]=[];
  let mode='success';
  localStorage.setItem('hologram.autocull.learner.v1', 'builtin');
  Object.assign(window,{
   __HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__:true,
   __nativeTest:{ setMode:(value:string)=>{mode=value;}, pending, calls:0 },
   __TAURI_INTERNALS__:{invoke:async(command:string,args:{request?:{pointwise:unknown[];pairs:unknown[];predict:unknown[]}}={})=>{
    if(command==='score_autocull_native') {
      const test=Reflect.get(window,'__nativeTest'); test.calls++;
      if(mode==='fail') throw new Error('Test native library unavailable');
      const request=args.request; if (!request) throw new Error('Missing native request'); const rows=request.pointwise.length+request.pairs.length*2;
      if(mode==='delay') await new Promise<void>(resolve=>pending.push(resolve));
      return {schema_version:1,xgboost_version:'3.1.1',ranker_version:'xgboost-personal-ranker-v1',scores:request.predict.map(()=>rows?0.5:null),training_rows:rows,train_ms:1,predict_ms:.1,base_margin:0};
    }
    if(['find_missing_photo_ids','read_autocull_feature_cache'].includes(command))return [];
    if(command==='plugin:event|listen')return 1;
    if(command==='get_photo_metadata')return {};
    return null;
   },transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:(p:string)=>p},
   __TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}}
  });
 });
 await page.goto(server.resolvedUrls!.local[0]);
 await page.evaluate(async(data:string)=>{
  const image=new Image();image.src='data:image/jpeg;base64,'+data;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=canvas.height=160;
  const ctx=canvas.getContext('2d')!;
  ctx.drawImage(image,0,0,160,160);
  const thumbnail=canvas.toDataURL('image/png').split(',')[1];
  const storePath='/src/lib/stores/photoStore.ts';
  const {photoStore}=await import(storePath) as typeof import('../src/lib/stores/photoStore.ts');
  photoStore.setPhotos(Array.from({length:3},(_,i)=>({id:`race-${i}`,file_name:`race-${i}.jpg`,file_path:`/fixture/race-${i}.jpg`,file_size:100,file_type:'JPEG',created_at:'2026-01-01',modified_at:'2026-01-01',thumbnail,exif:{date_taken:new Date(Date.UTC(2026,0,i+1)).toISOString()}})));
 }, readFileSync(new URL('./fixtures/stock/portrait.jpg', import.meta.url)).toString('base64'));
 await page.getByRole('button',{name:'AutoCull',exact:true}).click();
 console.log('openedAutoCull');
 const view=page.locator('[data-autocull-view]');
 await page.waitForFunction(()=>document.querySelector('[data-autocull-view]')?.getAttribute('data-autocull-active-learner')==='xgboost-native');
 assert.ok(await page.evaluate(()=>Reflect.get(window,'__nativeTest').calls)>0);
 console.log('native default ignores retired builtin preference');
 await view.getByRole('button',{name:/Review manually instead|Browse all stacks|Review .*exception/}).first().click();
 await page.locator('[data-autocull-advanced]').evaluate(el=>{if(el instanceof HTMLDetailsElement)el.open=true;});
 assert.equal(await page.locator('[data-autocull-learner-toggle]').count(),0);
 assert.doesNotMatch(await view.innerText(),/EXPERIMENTAL/);
 await page.evaluate(()=>Reflect.get(window,'__nativeTest').setMode('fail'));
 await view.getByRole('button',{name:'Refresh analysis',exact:true}).first().click();
 await page.waitForFunction(()=>document.querySelector('[data-autocull-view]')?.getAttribute('data-autocull-active-learner')==='builtin');
 assert.match(await view.innerText(),/built-in|fallback/i);
 assert.equal(await page.locator('[data-autocull-learner-error]').count(),0);
 await page.locator('[data-autocull-show-overview]').click();
 await page.waitForFunction(()=>{const button=document.querySelector('[data-autocull-apply]');return button instanceof HTMLButtonElement&&!button.disabled;});
 assert.equal(await page.locator('[data-autocull-apply]').isEnabled(),true);
 console.log('native failure automatically falls back with usable suggestions');
 await view.getByRole('button',{name:/Review manually instead/}).click();
 await page.locator('[data-autocull-advanced]').evaluate(el=>{if(el instanceof HTMLDetailsElement)el.open=true;});
 await page.evaluate(()=>Reflect.get(window,'__nativeTest').setMode('delay'));
 await view.getByRole('button',{name:'Refresh analysis',exact:true}).first().click();
 await page.waitForFunction(()=>Reflect.get(window,'__nativeTest').pending.length===1);
 console.log('native delayed');
 await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());
 await page.keyboard.press('p');
 await page.evaluate(()=>Reflect.get(window,'__nativeTest').pending.shift()());
 await page.waitForTimeout(200);
 assert.equal(await view.getAttribute('data-autocull-active-learner'),'builtin');
 assert.match(await view.innerText(),/Refresh to include 1 newer decision/);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('hologram.autocull.taste.v1.feedback.default')??'{}').refinements.length);
 assert.equal(saved,1);
 console.log('decision stale passed');
 await view.getByRole('button',{name:'Refresh analysis',exact:true}).first().click();
 await page.waitForFunction(()=>Reflect.get(window,'__nativeTest').pending.length===1);
 console.log('native delayed');
 await view.getByRole('button',{name:'Undo',exact:true}).click();
 await page.evaluate(()=>Reflect.get(window,'__nativeTest').pending.shift()());
 await page.waitForTimeout(200);
 assert.equal(await view.getAttribute('data-autocull-active-learner'),'builtin');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('hologram.autocull.taste.v1.feedback.default')??'{}').refinements.length),0);
 await page.screenshot({path:join(output, 'races.png'),fullPage:true});
 console.log('PASS automatic native default, retired preference ignored, no toggle, automatic fallback, usable apply, stale decision and undo protection', output);
} catch(error) { console.log(await page.locator('body').innerText());await page.screenshot({path:join(output, 'failure.png'),fullPage:true});throw error; } finally {await browser.close();await server.close();}
