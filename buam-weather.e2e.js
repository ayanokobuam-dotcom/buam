/* buam-weather.e2e.js — browser checks for the weather atmosphere layer.
 *
 * The three .test.js suites cover pure logic and run in the browser with no
 * tooling. This one cannot: contrast, layout, network silence and lifecycle
 * are properties of rendered pixels, so it drives a real browser.
 *
 *   npx playwright@latest install chromium     # once
 *   python3 -m http.server 8080                # serve the repo root
 *   PORT=8080 node buam-weather.e2e.js         # all parts
 *   PORT=8080 PART=B node buam-weather.e2e.js  # just contrast
 *
 * Parts: A viewports + network silence · B contrast · C snow collision
 *        D lifecycle · E persistence and interaction
 *
 * Screenshots, when a part takes them, go to ./.e2e-out/.
 *
 * A note on why this file is careful about what it refuses to measure: the
 * contrast part used to report ratios around 1.01 for the later states. Those
 * looked exactly like a catastrophic contrast failure. They were not — after
 * 60 seconds with no input the app shows its ambient screen, which covered the
 * page, and every element screenshot from then on was black. The old stub
 * replaced showAmbientScreen() but the idle timer had already been scheduled
 * with a direct reference to the original, so shadowing it did nothing. A
 * measurement that cannot tell "the text is unreadable" from "the camera was
 * pointing at a wall" is worse than no measurement, so both conditions now
 * return an error instead of a number.
 */
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const path = require('path');
// a local three.js copy is used when present; otherwise the CDN serves it.
// Either way it loads before recording starts, so it never counts as a
// weather-triggered request.
const T = process.env.THREE_DIR || path.join(__dirname, 'node_modules', 'three');
const B = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js';
const ROUTES = {
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': `${T}/build/three.min.js`,
  [`${B}/shaders/CopyShader.js`]: `${T}/examples/js/shaders/CopyShader.js`,
  [`${B}/shaders/LuminosityHighPassShader.js`]: `${T}/examples/js/shaders/LuminosityHighPassShader.js`,
  [`${B}/postprocessing/EffectComposer.js`]: `${T}/examples/js/postprocessing/EffectComposer.js`,
  [`${B}/postprocessing/RenderPass.js`]: `${T}/examples/js/postprocessing/RenderPass.js`,
  [`${B}/postprocessing/ShaderPass.js`]: `${T}/examples/js/postprocessing/ShaderPass.js`,
  [`${B}/postprocessing/UnrealBloomPass.js`]: `${T}/examples/js/postprocessing/UnrealBloomPass.js`,
  [`${B}/controls/OrbitControls.js`]: `${T}/examples/js/controls/OrbitControls.js`,
};
const PORT = process.env.PORT || 8080;
const OUT = path.join(__dirname, '.e2e-out');
fs.mkdirSync(OUT, { recursive: true });
const STATES = ['CLEAR','CLOUDY','RAIN','STORM','SNOW','FOG'];

const initScript = () => {
  const docStub = () => ({ set:()=>Promise.resolve(), update:()=>Promise.resolve(), get:()=>Promise.resolve({exists:false,data(){}}), onSnapshot:()=>function(){}, delete:()=>Promise.resolve() });
  const collectionStub = () => ({ doc:docStub, add:()=>Promise.resolve(docStub()), where:()=>collectionStub(), orderBy:()=>collectionStub(), onSnapshot:()=>function(){}, get:()=>Promise.resolve({docs:[],forEach(){}}) });
  const dbStub = { enablePersistence:()=>Promise.resolve(), collection:collectionStub, batch:()=>({set(){},update(){},delete(){},commit:()=>Promise.resolve()}) };
  function fb(){return dbStub;} fb.firestore=()=>dbStub; fb.firestore.FieldValue={arrayUnion:()=>[],serverTimestamp:()=>null};
  fb.auth=()=>({onAuthStateChanged(cb){cb(null);return function(){};},signOut:()=>Promise.resolve()}); fb.initializeApp=()=>({});
  window.firebase = fb;
  window.__spoken = [];
  class MU extends EventTarget { constructor(t){super();this.text=t;} }
  window.SpeechSynthesisUtterance = MU;
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{
    getVoices:()=>[{name:'Daniel',lang:'en-GB'}], cancel(){}, addEventListener(){},
    speak(u){ window.__spoken.push(u.text); setTimeout(()=>u.dispatchEvent(new Event('end')),40); } }});
  window.__script=[]; window.__recStarts=0;
  function Fake(){ this.lang=''; }
  Fake.prototype.start=function(){ window.__recStarts++; const s=window.__script.shift(); const self=this; self.__dead=false;
    setTimeout(()=>{ if(!self.__dead&&self.onstart) self.onstart(); },5);
    self.__t=setTimeout(()=>{ if(self.__dead) return;
      if(!s){ self.onend&&self.onend(); return; }
      const alt={transcript:s.text,confidence:s.conf};
      const res=Object.assign([alt],{isFinal:true,length:1});
      self.onresult&&self.onresult({resultIndex:0,results:Object.assign([res],{length:1})});
      self.onend&&self.onend(); },30); };
  Fake.prototype.stop=function(){}; Fake.prototype.abort=function(){ this.__dead=true; clearTimeout(this.__t); };
  delete window.SpeechRecognition; window.webkitSpeechRecognition = Fake;
};

async function boot(browser, viewport, extra) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [], requests = [];
  let recording = false;
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console', m=>{ if(m.type()==='error' && !/favicon/i.test(m.text())) errors.push('[console] '+m.text()); });
  page.on('request', r=>{ if(recording) requests.push(r.url()); });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (ROUTES[url] && fs.existsSync(ROUTES[url])) {
      return route.fulfill({status:200,contentType:'application/javascript',body:fs.readFileSync(ROUTES[url])});
    }
    if (url.includes('gstatic.com/firebasejs')) return route.fulfill({status:200,contentType:'application/javascript',body:''});
    return route.continue();
  });
  await page.addInitScript(initScript);
  if (extra) await page.addInitScript(extra);
  await page.goto(`http://localhost:${PORT}/index.html`);
  await (await page.waitForSelector('.boot-enter-btn',{timeout:15000})).click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#aiCoreCanvas',{state:'visible',timeout:10000});
  /* Disarming the idle watcher, properly. The old line replaced the global
     function, but armIdleWatch() had already run during boot and scheduled a
     timer holding a direct reference to the original — so after 60s the ambient
     screen still appeared, covered the page, and every element screenshot taken
     after that point came back black. Contrast then read 1.01 and looked like a
     finding. The timer has to be cleared, not shadowed. */
  await page.evaluate(()=>{
    if (typeof idleTimerId !== 'undefined' && idleTimerId) clearTimeout(idleTimerId);
    try { idleTimerId = null; } catch(e) {}
    window.showAmbientScreen = ()=>{};
    if (window.resetIdleTimer) window.resetIdleTimer = ()=>{};
  });
  await page.waitForTimeout(500);
  return { ctx, page, errors, requests, startRecording: ()=>{ recording = true; } };
}

// contrast measured from the real rendered pixels of an element's box
async function measureContrast(page, selector) {
  const el = await page.$(selector);
  if (!el) return { error: 'no element for ' + selector };
  const box = await el.boundingBox();
  if (!box || box.width < 4 || box.height < 4) return { error: 'box too small for ' + selector };
  // nothing may be covering the page, or the capture measures the cover
  const blocked = await page.evaluate(()=>{
    const a = document.getElementById('ambientScreen');
    const b = document.querySelector('.boot-screen, #bootScreen');
    return (a && a.classList.contains('visible')) ? 'ambient screen' :
           (b && getComputedStyle(b).display !== 'none' && !b.classList.contains('boot-hide')) ? 'boot screen' : null;
  });
  if (blocked) return { error: blocked + ' is covering the page' };
  const b64 = (await el.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,'+b64; await img.decode();
    const c = document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img,0,0);
    const d = x.getImageData(0,0,c.width,c.height).data;
    const lin = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    const L = [];
    for (let i=0;i<d.length;i+=4) L.push(0.2126*lin(d[i])+0.7152*lin(d[i+1])+0.0722*lin(d[i+2]));
    L.sort((a,b)=>a-b);
    const at = p => L[Math.min(L.length-1, Math.max(0, Math.floor(L.length*p)))];
    // background is the bulk of the box; foreground is the glyph extreme
    const bg = at(0.5), lo = at(0.02), hi = at(0.98);
    const fg = (hi - bg) >= (bg - lo) ? hi : lo;
    const a = Math.max(bg,fg), b2 = Math.min(bg,fg);
    /* A crop with no luminance spread contains no text — it is a blank capture,
       not a contrast failure. Reporting it as a ratio is how a broken harness
       produces findings that look real; say so instead. */
    if (hi - lo < 0.004) {
      return { error: 'capture is flat (no glyphs found)', lo:+lo.toFixed(4), hi:+hi.toFixed(4) };
    }
    return { ratio: +(((a+0.05)/(b2+0.05)).toFixed(2)), bg:+bg.toFixed(4), fg:+fg.toFixed(4) };
  }, b64);
}

const LAUNCH = { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM) LAUNCH.executablePath = process.env.CHROMIUM;

const PART = process.env.PART || 'ALL';
(async () => {
  const browser = await chromium.launch(LAUNCH);
  const R = { viewports: {}, contrast: {}, collisions: {}, network: {}, lifecycle: {}, persistence: {}, interaction: {}, errors: [] };

  // ---------- A. every state at every viewport ----------
  if (PART==='ALL'||PART==='A') for (const [label, viewport] of [['320',{width:320,height:640}],['390',{width:390,height:844}],['768',{width:768,height:1024}],['1280',{width:1280,height:900}]]) {
    const { ctx, page, errors, requests, startRecording } = await boot(browser, viewport);
    const per = {};
    startRecording();
    for (const st of STATES) {
      await page.evaluate(s => { BuamWeather.setMode('MANUAL'); BuamWeather.setState(s); }, st);
      await page.waitForTimeout(700);
      per[st] = await page.evaluate(()=>({
        attr: document.documentElement.getAttribute('data-weather'),
        running: BuamWeather.isRunning(),
        hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        // the weather layer must never be the element under a tap
        hitCentre: (()=>{ const e=document.elementFromPoint(innerWidth/2, innerHeight/2); return e?e.id||e.className.toString().slice(0,40):null; })(),
        canvasPE: getComputedStyle(document.getElementById('wxCanvas')).pointerEvents
      }));
    }
    R.viewports[label] = per;
    R.network[label] = requests.filter(u=>!u.startsWith(`http://localhost:${PORT}`));
    R.network[label+'_total'] = requests.length;
    if (errors.length) R.errors.push(label+': '+errors.join(' | '));
    await ctx.close();
  }

  // ---------- B. contrast in every state (390px, the real device width) ----------
  if (PART==='ALL'||PART==='B') {
    const { ctx, page, errors } = await boot(browser, {width:390,height:844});
    const targets = {
      cardTitle: '.cc-card-title',
      statName: '.cc-stat-row .cc-stat-name',
      statVal: '.cc-stat-row .cc-stat-val',
      headerLogo: '.logo',
      statusPill: '.cc-status-pill',
      button: '#sndToggle'
    };
    for (const st of STATES) {
      await page.evaluate(s => { BuamWeather.setMode('MANUAL'); BuamWeather.setState(s, {intensity:1}); }, st);
      await page.waitForTimeout(2600); // let the crossfade and accumulation settle
      const row = {};
      for (const [name, sel] of Object.entries(targets)) {
        const m = await measureContrast(page, sel);
        row[name] = m;
        if (m && m.error) R.errors.push(`contrast ${st}/${name}: ${m.error}`);
      }
      R.contrast[st] = row;
    }
    if (errors.length) R.errors.push('contrast: '+errors.join(' | '));
    await ctx.close();
  }

  // ---------- C. snow collision: decorative boxes vs real text ----------
  if (PART==='ALL'||PART==='C') {
    const { ctx, page, errors } = await boot(browser, {width:390,height:844});
    await page.evaluate(()=>{ BuamWeather.setMode('MANUAL'); BuamWeather.setState('SNOW',{intensity:1}); });
    await page.waitForTimeout(23000); // full 20s accumulation ramp plus margin
    R.collisions = await page.evaluate(()=>{
      const sels = ['header','.cc-card','.app-section','.cc-status-pill'];
      const out = { accum: getComputedStyle(document.documentElement).getPropertyValue('--wx-accum').trim(), overlaps: [], checked: 0 };
      /* What matters is where the snow is *painted*, not how big the element
         is. The cap pseudo-element spans the whole surface — inset:0, so it can
         inherit the border radius and follow the rounded corners — and a mask
         limits the ink to a band at the top. Measuring its box therefore
         reported an overlap with every line of text on the card, which is not a
         collision, it is the box being the wrong thing to measure. The mask
         height is the ink height. Icicles are the other way round: their box is
         their ink, hanging below the bottom edge. */
      const pseudoRect = (el, which)=>{
        const cs = getComputedStyle(el, which);
        const r = el.getBoundingClientRect();
        if(which === '::after'){
          const h = parseFloat(cs.height)||0;
          if(!h) return null;
          return { top: r.bottom, bottom: r.bottom + h, left: r.left + (parseFloat(cs.left)||0),
                   right: r.right - (parseFloat(cs.right)||0), h, source:'box' };
        }
        const size = cs.maskSize || cs.webkitMaskSize || '';
        const h = parseFloat(size.split(/\s+/)[1] || '') || 0;
        if(!h) return null;
        return { top: r.top, bottom: r.top + h, left: r.left, right: r.right, h, source:'mask' };
      };
      sels.forEach(sel=>{
        document.querySelectorAll(sel).forEach(el=>{
          if(!el.offsetParent && el.tagName!=='HEADER') return;
          const r = el.getBoundingClientRect();
          if(r.width < 5) return;
          // every text-bearing descendant in this surface
          const texts = [];
          el.querySelectorAll('*').forEach(n=>{
            if(!n.textContent || !n.textContent.trim()) return;
            if(n.children.length) return;              // leaf nodes only
            const nr = n.getBoundingClientRect();
            if(nr.width>0 && nr.height>0) texts.push({ node:n.className||n.tagName, r:nr });
          });
          ['::before','::after'].forEach(which=>{
            const pr = pseudoRect(el, which);
            if(!pr) return;
            out.checked++;
            texts.forEach(t=>{
              const overlap = !(pr.bottom <= t.r.top || pr.top >= t.r.bottom || pr.right <= t.r.left || pr.left >= t.r.right);
              if(overlap) out.overlaps.push({ sel, which, text:String(t.node).slice(0,40),
                pseudo:[Math.round(pr.top),Math.round(pr.bottom)], textBox:[Math.round(t.r.top),Math.round(t.r.bottom)] });
            });
          });
        });
      });
      return out;
    });
    await page.screenshot({ path: `${OUT}/wx_snow_full.png` });
    // melt must ramp down, not snap
    await page.evaluate(()=> BuamWeather.setState('CLEAR'));
    const melt = [];
    for (let i=0;i<5;i++){ await page.waitForTimeout(1200); melt.push(await page.evaluate(()=>+BuamWeather.getAccum().toFixed(3))); }
    R.collisions.meltSeries = melt;
    R.collisions.meltMonotonic = melt.every((v,i)=> i===0 || v <= melt[i-1]);
    if (errors.length) R.errors.push('collision: '+errors.join(' | '));
    await ctx.close();
  }

  // ---------- D. interaction, lifecycle, persistence ----------
  if (PART==='ALL'||PART==='D') {
    const { ctx, page, errors, requests, startRecording } = await boot(browser, {width:390,height:844});
    await page.evaluate(()=>{ BuamWeather.setMode('MANUAL'); BuamWeather.setState('STORM'); });
    await page.waitForTimeout(800);
    startRecording();

    // task form still usable under the heaviest state
    await page.click('#menuToggleBtn'); await page.waitForTimeout(400);
    await page.click('.sidebar-link[data-view="tasks"]'); await page.waitForTimeout(300);
    await page.fill('#titleInput','weather regression task');
    await page.click('#addBtn'); await page.waitForTimeout(300);
    R.interaction.taskAdded = await page.evaluate(()=> tasks.some(t=>t.title==='weather regression task'));

    // modal opens and is on top of the weather layer
    await page.evaluate(()=> switchView('home')); await page.waitForTimeout(300);
    await page.click('#ccCmdFocus'); await page.waitForTimeout(400);
    R.interaction.modalOpen = await page.evaluate(()=> !document.getElementById('timerOverlay').classList.contains('hidden'));
    R.interaction.modalOnTop = await page.evaluate(()=>{
      const m = document.querySelector('#timerOverlay .dose-modal').getBoundingClientRect();
      const el = document.elementFromPoint(m.left+m.width/2, m.top+20);
      return !!(el && el.closest('#timerOverlay'));
    });
    await page.click('#timerSetupCancel'); await page.waitForTimeout(300);

    // voice still works under weather
    await page.evaluate(()=>{ window.__script=[{text:'เพิ่มงาน ทดสอบอากาศ',conf:1.0}]; window.__spoken=[]; activateBuamCore(); });
    await page.waitForTimeout(900);
    R.interaction.voiceTaskCreated = await page.evaluate(()=> tasks.some(t=>t.title.indexOf('ทดสอบอากาศ')!==-1));

    // weather picker itself
    await page.click('#wxIndicator'); await page.waitForTimeout(400);
    R.interaction.pickerOpens = await page.evaluate(()=> !document.getElementById('weatherOverlay').classList.contains('hidden'));
    await page.click('#wxGrid button[data-wx="SNOW"]'); await page.waitForTimeout(400);
    R.interaction.pickerSetsState = await page.evaluate(()=> BuamWeather.getState());
    R.interaction.pickerLeavesRotate = await page.evaluate(()=> BuamWeather.getMode());
    await page.click('#weatherCloseBtn'); await page.waitForTimeout(200);

    // lifecycle: hidden parks the loop, one loop only
    const before = await page.evaluate(()=> BuamWeather.getLoopStarts());
    await page.evaluate(()=>{ Object.defineProperty(document,'hidden',{value:true,configurable:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    /* named for what it holds. The old field was called pausedWhenHidden but
       stored isRunning(), so a correct result printed as `false` and read like
       a failure. */
    R.lifecycle.runningWhileHidden = await page.evaluate(()=> BuamWeather.isRunning());
    R.lifecycle.parksWhenHidden = !R.lifecycle.runningWhileHidden;
    await page.evaluate(()=>{ Object.defineProperty(document,'hidden',{value:false,configurable:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    R.lifecycle.resumes = await page.evaluate(()=> BuamWeather.isRunning());
    await page.evaluate(()=>{ for(let i=0;i<40;i++) BuamWeather.setState(['RAIN','SNOW','STORM'][i%3]); });
    await page.waitForTimeout(400);
    R.lifecycle.loopStartsDelta = (await page.evaluate(()=> BuamWeather.getLoopStarts())) - before;
    R.lifecycle.stillOneLoop = await page.evaluate(()=> BuamWeather.isRunning());

    R.network.duringInteraction = requests.filter(u=>!u.startsWith(`http://localhost:${PORT}`));

    // persistence across reload
    await page.evaluate(()=>{ BuamWeather.setMode('MANUAL'); BuamWeather.setState('FOG',{intensity:0.4}); });
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForTimeout(600);
    const enter = await page.$('.boot-enter-btn'); if(enter){ await enter.click(); await page.waitForTimeout(400); await page.keyboard.press('Escape'); }
    await page.waitForTimeout(700);
    R.persistence = await page.evaluate(()=>({
      state: BuamWeather.getState(), mode: BuamWeather.getMode(),
      intensity: BuamWeather.getIntensity(),
      attr: document.documentElement.getAttribute('data-weather')
    }));
    if (errors.length) R.errors.push('interaction: '+errors.join(' | '));
    await ctx.close();
  }

  // ---------- E. reduced motion ----------
  if (PART==='ALL'||PART==='E') {
    const ctx = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, reducedMotion:'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e=>errors.push(e.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (ROUTES[url] && fs.existsSync(ROUTES[url])) {
      return route.fulfill({status:200,contentType:'application/javascript',body:fs.readFileSync(ROUTES[url])});
    }
      if (url.includes('gstatic.com/firebasejs')) return route.fulfill({status:200,contentType:'application/javascript',body:''});
      return route.continue();
    });
    await page.addInitScript(initScript);
    await page.goto(`http://localhost:${PORT}/index.html`);
    const b = await page.waitForSelector('.boot-enter-btn',{timeout:15000}); await b.click();
    await page.waitForTimeout(400); await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    await page.evaluate(()=>{ BuamWeather.setMode('MANUAL'); BuamWeather.setState('STORM'); });
    await page.waitForTimeout(700);
    R.reducedMotion = await page.evaluate(()=>({
      reduced: BuamWeather.isReducedMotion(),
      running: BuamWeather.isRunning(),
      budget: BuamWeather.getBudget(),
      attrStillSet: document.documentElement.getAttribute('data-weather'),
      flashHidden: getComputedStyle(document.getElementById('wxFlash')).display
    }));
    if (errors.length) R.errors.push('reduced: '+errors.join(' | '));
    await ctx.close();
  }

  console.log(JSON.stringify(R, null, 2));
  await browser.close();
})();
