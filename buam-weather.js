/* B.U.A.M. weather atmosphere — an enhancement layer over the existing UI.
 *
 * Fully offline by design: no fetch, no XMLHttpRequest, no geolocation, no
 * external assets. Weather is either chosen by the user (MANUAL) or advanced by
 * a local deterministic state machine (ROTATE). Nothing here can fail in a way
 * that blocks the app — every entry point is guarded and falls back to CLEAR.
 *
 * Structure mirrors buam-money.js / buam-voice.js: the decision logic at the
 * top is pure and unit-tested on its own; the renderer below owns exactly one
 * canvas, one requestAnimationFrame loop and one reusable particle pool, as the
 * spec requires. Static, decorative surface effects (snow caps, icicles, wet
 * glass) are CSS driven by `<html data-weather>` and a handful of custom
 * properties, so the high-frequency work stays on the canvas and the cheap work
 * stays in the compositor.
 */
(function (global) {
  "use strict";

  /* ================================================================
   * pure: states, modes, timing
   * ================================================================ */

  var STATES = ["CLEAR", "CLOUDY", "RAIN", "STORM", "SNOW", "FOG"];
  var MODES = ["MANUAL", "ROTATE"];
  var STORAGE_KEY = "buam-weather-mode";

  var DEFAULT_STATE = "CLEAR";
  var DEFAULT_MODE = "MANUAL";
  var DEFAULT_INTENSITY = 0.75;

  var TRANSITION_MS = 1800;   // crossfade between states (spec: 1-3s)
  var ACCUM_IN_MS = 20000;    // snow builds up
  var ACCUM_OUT_MS = 8000;    // and melts faster than it fell

  // minutes each state holds in ROTATE mode
  var DWELL_MINUTES = {
    CLEAR:  [20, 40],
    CLOUDY: [15, 30],
    RAIN:   [10, 25],
    STORM:  [3, 10],
    SNOW:   [10, 30],
    FOG:    [5, 20]
  };

  /* Transition weights, kept as one editable table. Deliberately biased toward
     plausible sequences — storms arrive through rain rather than out of a clear
     sky — and no state can ever transition to itself. */
  var WEIGHTS = {
    CLEAR:  { CLOUDY: 6, FOG: 2, RAIN: 1.5, SNOW: 1, STORM: 0.3 },
    CLOUDY: { RAIN: 5, CLEAR: 4, FOG: 2.5, SNOW: 2, STORM: 1 },
    RAIN:   { CLOUDY: 5, STORM: 3, CLEAR: 2, FOG: 1.5, SNOW: 1 },
    STORM:  { RAIN: 7, CLOUDY: 3, CLEAR: 1, FOG: 0.5, SNOW: 0.5 },
    SNOW:   { CLOUDY: 5, CLEAR: 3, FOG: 2, RAIN: 1, STORM: 0.3 },
    FOG:    { CLOUDY: 5, CLEAR: 4, RAIN: 2, SNOW: 1.5, STORM: 0.3 }
  };

  function isState(s) { return STATES.indexOf(String(s || "").toUpperCase()) !== -1; }
  function isMode(m) { return MODES.indexOf(String(m || "").toUpperCase()) !== -1; }

  function normState(s) {
    var up = String(s || "").toUpperCase();
    return isState(up) ? up : DEFAULT_STATE;
  }
  function normIntensity(v) {
    var n = Number(v);
    if (!isFinite(n)) return DEFAULT_INTENSITY;
    return Math.min(1, Math.max(0, n));
  }

  /* Weighted pick that can never return `current`. rng is injectable so the
     rotation is deterministic under test. */
  function pickNextState(current, rng) {
    var from = normState(current);
    var table = WEIGHTS[from] || {};
    var keys = [], total = 0, k;
    for (k in table) {
      if (!Object.prototype.hasOwnProperty.call(table, k)) continue;
      if (k === from || !isState(k)) continue;
      keys.push(k);
      total += table[k];
    }
    if (!keys.length || total <= 0) {
      var others = STATES.filter(function (s) { return s !== from; });
      return others[0];
    }
    var r = (typeof rng === "function" ? rng() : Math.random()) * total;
    for (var i = 0; i < keys.length; i++) {
      r -= table[keys[i]];
      if (r <= 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  function dwellMs(state, rng) {
    var range = DWELL_MINUTES[normState(state)];
    var r = typeof rng === "function" ? rng() : Math.random();
    var minutes = range[0] + (range[1] - range[0]) * Math.min(1, Math.max(0, r));
    return Math.round(minutes * 60000);
  }

  /* Smoothstep, so accumulation eases in and out instead of ramping linearly.
     Monotonic on [0,1], which the tests rely on. */
  function accumEase(t) {
    var x = Math.min(1, Math.max(0, Number(t) || 0));
    return x * x * (3 - 2 * x);
  }

  /* Particle budget from device capability. Mirrors the lowPower heuristic the
     3D core already uses (index.html), so a phone gets the same treatment in
     both systems. */
  function particleBudget(env) {
    env = env || {};
    var w = env.width || 390;
    var h = env.height || 844;
    var cores = env.cores == null ? 4 : env.cores;
    if (env.reducedMotion) return { tier: "none", rain: 0, snow: 0, pool: 0 };

    var small = Math.min(w, h) < 520;
    var tier = (small && cores <= 2) || cores <= 2 ? "minimal"
             : (small || cores <= 4) ? "reduced"
             : "full";
    var base = tier === "full" ? 260 : tier === "reduced" ? 150 : 80;
    // scale with screen area, clamped so a desktop does not explode the count
    var area = (w * h) / (390 * 844);
    var rain = Math.round(base * Math.min(2.2, Math.max(0.55, area)));
    var snow = Math.round(rain * 0.75);
    // STORM asks for more than RAIN, so the pool has to cover the worst case
    return { tier: tier, rain: rain, snow: snow, pool: Math.round(rain * 1.6) };
  }

  /* Parses whatever is in localStorage. Anything missing, malformed, corrupt or
     out of range degrades to CLEAR/MANUAL rather than throwing — a broken
     storage entry must never stop the app from starting. */
  function parseStored(raw) {
    var fallback = { mode: DEFAULT_MODE, state: DEFAULT_STATE, intensity: DEFAULT_INTENSITY };
    if (raw == null || raw === "") return fallback;
    var data;
    try { data = JSON.parse(raw); }
    catch (e) { return fallback; }
    if (!data || typeof data !== "object") return fallback;
    return {
      mode: isMode(data.mode) ? String(data.mode).toUpperCase() : DEFAULT_MODE,
      state: isState(data.state) ? String(data.state).toUpperCase() : DEFAULT_STATE,
      intensity: normIntensity(data.intensity == null ? DEFAULT_INTENSITY : data.intensity)
    };
  }

  function serializeStored(mode, state, intensity) {
    return JSON.stringify({ mode: mode, state: state, intensity: intensity });
  }

  /* ================================================================
   * runtime
   * ================================================================ */

  var root = null, canvas = null, ctx = null, flashEl = null;
  var state = DEFAULT_STATE, mode = DEFAULT_MODE, intensity = DEFAULT_INTENSITY;
  var prevState = null, mix = 1;
  var accumT = 0, accum = 0;          // raw ramp 0..1 and its eased value
  var rampFrom = 0, rampTo = 0, rampStart = 0, rampDur = 1;
  var particles = [], budget = particleBudget({});
  var rafId = null, loopStarts = 0, lastT = 0;
  var rotateTimer = null;
  var nextFlashIn = 0, flashUntil = 0;
  /* Self-tuning quality. The target device cannot be profiled from here, so
     rather than guess a particle count the renderer watches its own frame times
     and steps down if it cannot hold a smooth frame. Downgrade only — stepping
     back up would oscillate on a device sitting near the threshold. */
  var qualityScale = 1, qualitySteps = 0;
  var QUALITY_FLOOR = 2;          // at most two downgrades
  var FRAME_BUDGET_MS = 22;       // ~45fps; below this nothing is done
  var frameAcc = 0, frameCount = 0;

  function watchFrameCost(dtMs) {
    if (qualitySteps >= QUALITY_FLOOR) return;
    frameAcc += dtMs;
    frameCount++;
    if (frameCount < 90) return;
    var avg = frameAcc / frameCount;
    frameAcc = 0; frameCount = 0;
    if (avg > FRAME_BUDGET_MS) {
      qualitySteps++;
      qualityScale *= 0.55;
    }
  }
  var started = false, reducedMotion = false;
  var w = 0, h = 0, dpr = 1;
  var listeners = [];

  function prefersReducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
  }

  function readStorage() {
    try { return parseStored(global.localStorage.getItem(STORAGE_KEY)); }
    catch (e) { return parseStored(null); }
  }
  function writeStorage() {
    try { global.localStorage.setItem(STORAGE_KEY, serializeStored(mode, state, intensity)); }
    catch (e) { /* private mode / quota: the feature still works, it just forgets */ }
  }

  /* Per-state atmosphere knobs the CSS reads. Background dimming is applied as
     a filter on the existing #bgCanvas/#bgCanvas3D rather than by editing their
     opacity rules, so the original background system is left intact. */
  var ATMOSPHERE = {
    CLEAR:  { bgDim: 1.00, haze: 0.00, dark: 0.00 },
    // overcast has no particles to carry it, so the wash has to be strong
    // enough to read on its own — at the old numbers it moved the screen 1.6%
    CLOUDY: { bgDim: 0.55, haze: 0.62, dark: 0.34 },
    RAIN:   { bgDim: 0.70, haze: 0.22, dark: 0.18 },
    STORM:  { bgDim: 0.48, haze: 0.30, dark: 0.38 },
    SNOW:   { bgDim: 0.62, haze: 0.26, dark: 0.12 },
    // fog pushes the world further back instead of blurring it — the recession
    // is what sells depth once the blur is gone
    FOG:    { bgDim: 0.34, haze: 0.78, dark: 0.14 }
  };

  /* The haze is two stacked layers rather than one. A single layer could only
     fade its own opacity, while the gradients underneath it swapped in a single
     frame — measured, 96% of the change between two lit states landed in the
     first 120ms of an 1800ms transition, which is a cut, not a crossfade. The
     outgoing state now fades out while the incoming one fades in. */
  var hazeLayers = null, hazeActive = 0;
  function getHazeLayers() {
    if (!hazeLayers && global.document) {
      var a = global.document.getElementById("wxHazeA");
      var b = global.document.getElementById("wxHazeB");
      if (a && b) hazeLayers = [a, b];
    }
    return hazeLayers;
  }

  function applyHaze(target) {
    var layers = getHazeLayers();
    if (!layers) return;
    var active = layers[hazeActive];
    if (active.getAttribute("data-wx") === state) {
      // same state, only the intensity moved — nothing to cross anything with
      active.style.opacity = target;
      return;
    }
    var incoming = layers[hazeActive ^ 1];
    // land the new look at zero before fading it up, or the swap is the pop
    incoming.style.transition = "none";
    incoming.style.opacity = "0";
    incoming.setAttribute("data-wx", state);
    void incoming.offsetWidth;
    incoming.style.transition = "";
    incoming.style.opacity = target;
    active.style.opacity = "0";
    hazeActive ^= 1;
  }

  function applyCssState() {
    if (!root) return;
    root.setAttribute("data-weather", state);
    var a = ATMOSPHERE[state] || ATMOSPHERE.CLEAR;
    var k = 0.35 + intensity * 0.65;   // intensity never fully erases a state
    root.style.setProperty("--wx-intensity", intensity.toFixed(3));
    root.style.setProperty("--wx-bg-dim", (1 - (1 - a.bgDim) * k).toFixed(3));
    root.style.setProperty("--wx-haze", (a.haze * k).toFixed(3));
    root.style.setProperty("--wx-dark", (a.dark * k).toFixed(3));
    applyHaze((a.haze * k).toFixed(3));
  }

  /* The accumulation ramp is driven by the wall clock, not by accumulated
     frame deltas. Frame time is clamped for physics stability, so a dt-driven
     ramp silently stretches on a slow device — measured at 23s to reach only
     0.61 under a software renderer. Wall-clock keeps "20 seconds" honest at any
     frame rate, and the ramp stays monotonic because progress only moves one
     way between retargets. */
  function retargetAccum() {
    var target = state === "SNOW" ? 1 : 0;
    if (target === rampTo && rampDur > 1) return;
    rampFrom = accumT;
    rampTo = target;
    rampStart = performance.now();
    var full = target > rampFrom ? ACCUM_IN_MS : ACCUM_OUT_MS;
    rampDur = Math.max(1, full * Math.abs(target - rampFrom));
  }

  function updateAccum() {
    if (accumT === rampTo) return false;
    var p = Math.min(1, Math.max(0, (performance.now() - rampStart) / rampDur));
    accumT = rampFrom + (rampTo - rampFrom) * p;
    if (p >= 1) accumT = rampTo;
    accum = accumEase(accumT);
    if (root) root.style.setProperty("--wx-accum", accum.toFixed(4));
    return true;
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state, mode, intensity); } catch (e) {}
    }
  }

  /* ---- particle pool ---- */

  /* Particles are grouped into a few depth bands. Everything that varies per
     particle in a way Canvas2D charges for — globalAlpha, lineWidth, and the
     draw submission itself — is shared across a whole band, so a frame costs a
     handful of draw calls instead of one per particle. Measured before this
     change: 150 calls/frame in RAIN, 269 in STORM, 153 in SNOW, costing +29ms
     per frame over CLEAR. */
  var BANDS = 4;
  var bandIndex = [];      // bandIndex[b] = [particle indices in that band]

  function seedParticle(p) {
    p.layer = Math.random();                   // 0 = far, 1 = near
    p.band = Math.min(BANDS - 1, Math.floor(p.layer * BANDS));
    p.seed = Math.random() * Math.PI * 2;
    p.sway = 0.4 + Math.random() * 1.2;
    p.len = 8 + Math.random() * 22;
    p.r = 0.7 + Math.random() * 2.1;
    p.x = Math.random() * w;
    p.y = Math.random() * h;
    return p;
  }

  /* Recycling only moves a particle back to the top. Its depth stays put, so
     the band buckets built once at pool time never have to be rebuilt. */
  function recycle(p) {
    p.x = Math.random() * w;
    p.y = -20 - Math.random() * 60;
  }

  function buildPool() {
    var target = Math.max(budget.pool, 0);
    particles.length = 0;
    bandIndex = [];
    for (var b = 0; b < BANDS; b++) bandIndex.push([]);
    for (var i = 0; i < target; i++) {
      var p = seedParticle({});
      particles.push(p);
      bandIndex[p.band].push(i);
    }
  }

  function activeCount(kind) {
    var cap = Math.max(0, Math.round(particles.length * qualityScale));
    if (kind === "RAIN") return Math.min(cap, budget.rain);
    if (kind === "STORM") return Math.min(cap, Math.round(budget.rain * 1.6));
    if (kind === "SNOW") return Math.min(cap, budget.snow);
    return 0;
  }

  function stepParticles(dt, kind) {
    var n = activeCount(kind);
    if (!n) return;
    var t = performance.now() / 1000;
    var k = 0.5 + intensity * 0.5;
    var storm = kind === "STORM";
    var snow = kind === "SNOW";
    var speed = storm ? 1500 : 1000;
    var drift = storm ? 150 : 55;
    for (var i = 0; i < n; i++) {
      var p = particles[i];
      if (snow) {
        p.y += (16 + p.layer * 62) * k * dt;
        p.x += Math.sin(t * p.sway + p.seed) * (5 + p.layer * 16) * dt
             + (6 + p.layer * 10) * 0.25 * dt;
      } else {
        p.y += (speed * (0.35 + p.layer)) * k * dt;
        p.x += drift * (0.3 + p.layer) * dt;
      }
      if (p.y > h + 30 || p.x > w + 40) recycle(p);
    }
  }

  function drawParticles(kind, alpha) {
    var n = activeCount(kind);
    if (!n || alpha <= 0.01) return;
    var b, list, i, idx, p, any;
    var TAU = Math.PI * 2;

    if (kind === "SNOW") {
      ctx.fillStyle = "#ffffff";
      for (b = 0; b < BANDS; b++) {
        var lf = (b + 0.5) / BANDS;
        list = bandIndex[b];
        ctx.globalAlpha = alpha * (0.18 + lf * 0.62);
        ctx.beginPath();
        any = false;
        for (i = 0; i < list.length; i++) {
          idx = list[i];
          if (idx >= n) continue;
          p = particles[idx];
          var r = p.r * (0.5 + lf * 0.9);
          ctx.moveTo(p.x + r, p.y);      // lift the pen so arcs are not joined
          ctx.arc(p.x, p.y, r, 0, TAU);
          any = true;
        }
        if (any) ctx.fill();
      }
    } else {
      var storm = kind === "STORM";
      var dx = storm ? 5 : 2.4;
      ctx.strokeStyle = storm ? "#cfe6ff" : "#bcd8ea";
      ctx.lineCap = "round";
      for (b = 0; b < BANDS; b++) {
        var lf2 = (b + 0.5) / BANDS;
        list = bandIndex[b];
        ctx.globalAlpha = alpha * (0.10 + lf2 * (storm ? 0.42 : 0.30));
        ctx.lineWidth = 0.6 + lf2 * (storm ? 1.5 : 1.0);
        ctx.beginPath();
        any = false;
        for (i = 0; i < list.length; i++) {
          idx = list[i];
          if (idx >= n) continue;
          p = particles[idx];
          var len = p.len * (0.5 + lf2) * (storm ? 1.5 : 1);
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - dx, p.y - len);
          any = true;
        }
        if (any) ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---- frame loop: exactly one, guarded so repeated state changes cannot
     ever start a second ---- */

  function frame(ts) {
    rafId = global.requestAnimationFrame(frame);
    var rawMs = ts - lastT;
    var dt = Math.min(0.05, rawMs / 1000);
    if (!(dt > 0)) dt = 0.016;
    lastT = ts;
    if (rawMs > 0 && rawMs < 1000) watchFrameCost(rawMs);

    if (mix < 1) mix = Math.min(1, mix + (dt * 1000) / TRANSITION_MS);

    // snow accumulation ramp — separate from the crossfade, and monotonic
    updateAccum();

    ctx.clearRect(0, 0, w, h);
    if (!reducedMotion) {
      stepParticles(dt, state);
      if (prevState && mix < 1) drawParticles(prevState, 1 - mix);
      drawParticles(state, mix);

      if (state === "STORM") {
        nextFlashIn -= dt;
        if (nextFlashIn <= 0) {
          flashUntil = performance.now() + 260;
          nextFlashIn = 7 + Math.random() * 12;   // occasional, never a strobe
        }
        var left = flashUntil - performance.now();
        if (flashEl) {
          // capped low so it reads as distant sheet lightning, not a flashbang
          flashEl.style.opacity = left > 0 ? (Math.max(0, left / 260) * 0.16 * intensity).toFixed(3) : "0";
        }
      } else if (flashEl && flashEl.style.opacity !== "0") {
        flashEl.style.opacity = "0";
      }
    }
  }

  function shouldRun() {
    if (!started || !ctx) return false;
    try { if (global.document.hidden) return false; } catch (e) {}
    // the ambient/idle screen covers this layer entirely — no point rendering
    try {
      var amb = global.document.getElementById("ambientScreen");
      if (amb && amb.classList.contains("visible")) return false;
    } catch (e) {}
    if (reducedMotion) return false;
    if (state === "CLEAR" || state === "CLOUDY" || state === "FOG") return false;
    return true;
  }

  function syncLoop() {
    if (shouldRun()) {
      if (rafId == null) {
        loopStarts++;
        lastT = performance.now();
        rafId = global.requestAnimationFrame(frame);
      }
    } else if (rafId != null) {
      global.cancelAnimationFrame(rafId);
      rafId = null;
      if (ctx) ctx.clearRect(0, 0, w, h);
      if (flashEl) flashEl.style.opacity = "0";
    }
  }

  /* When the loop is parked (CLEAR/CLOUDY/FOG, hidden tab, reduced motion) the
     accumulation ramp still has to finish, or leaving SNOW would freeze the
     snow caps in place forever. This settles it without a render loop. */
  var settleTimer = null;
  function settleAccumulation() {
    if (settleTimer) { clearInterval(settleTimer); settleTimer = null; }
    if (accumT === rampTo) return;
    settleTimer = setInterval(function () {
      if (rafId != null) { clearInterval(settleTimer); settleTimer = null; return; }
      if (!updateAccum()) { clearInterval(settleTimer); settleTimer = null; }
    }, 100);
  }

  /* ---- rotation ---- */

  function clearRotate() {
    if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null; }
  }
  function scheduleRotate() {
    clearRotate();
    if (mode !== "ROTATE") return;
    rotateTimer = setTimeout(function () {
      if (mode !== "ROTATE") return;
      applyState(pickNextState(state), intensity);
      scheduleRotate();
    }, dwellMs(state));
  }

  /* ---- public surface ---- */

  function applyState(next, nextIntensity) {
    var target = normState(next);
    var newIntensity = nextIntensity == null ? intensity : normIntensity(nextIntensity);
    if (target === state && newIntensity === intensity) return;
    if (target !== state) {
      prevState = state;
      mix = 0;
    }
    state = target;
    intensity = newIntensity;
    applyCssState();
    writeStorage();
    retargetAccum();
    syncLoop();
    settleAccumulation();
    emit();
  }

  function setState(next, opts) {
    applyState(next, opts && opts.intensity != null ? opts.intensity : null);
  }

  function setMode(next) {
    var m = isMode(next) ? String(next).toUpperCase() : DEFAULT_MODE;
    if (m === mode) return;
    mode = m;
    writeStorage();
    if (mode === "ROTATE") scheduleRotate();
    else clearRotate();
    emit();
  }

  function measure() {
    if (!canvas) return;
    w = global.innerWidth;
    h = global.innerHeight;
    // 1.5 rather than 2: these are soft, blurred particles, so the extra 78% of
    // pixels a retina buffer costs buys nothing visible here
    dpr = Math.min(global.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init(opts) {
    if (started) return true;
    opts = opts || {};
    try {
      root = global.document.documentElement;
      canvas = global.document.getElementById("wxCanvas");
      flashEl = global.document.getElementById("wxFlash");
      if (!canvas || !canvas.getContext) return false;
      ctx = canvas.getContext("2d");
      if (!ctx) return false;
    } catch (e) { return false; }

    reducedMotion = prefersReducedMotion();
    var stored = readStorage();
    mode = stored.mode;
    state = stored.state;
    intensity = stored.intensity;

    budget = particleBudget({
      width: global.innerWidth,
      height: global.innerHeight,
      cores: global.navigator ? global.navigator.hardwareConcurrency : 4,
      reducedMotion: reducedMotion
    });

    measure();
    buildPool();
    started = true;

    // snow that was already on the surfaces when the app closed is still there
    accumT = state === "SNOW" ? 1 : 0;
    accum = accumT;
    rampFrom = accumT; rampTo = accumT; rampStart = performance.now(); rampDur = 1;
    if (root) root.style.setProperty("--wx-accum", accum.toFixed(4));
    applyCssState();
    if (mode === "ROTATE") scheduleRotate();
    syncLoop();

    var resizeTimer = null;
    global.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        measure();
        budget = particleBudget({
          width: global.innerWidth,
          height: global.innerHeight,
          cores: global.navigator ? global.navigator.hardwareConcurrency : 4,
          reducedMotion: reducedMotion
        });
        buildPool();
      }, 180);
    });
    global.document.addEventListener("visibilitychange", syncLoop);

    try {
      if (global.matchMedia) {
        var mq = global.matchMedia("(prefers-reduced-motion: reduce)");
        var onChange = function () {
          reducedMotion = prefersReducedMotion();
          budget = particleBudget({
            width: global.innerWidth, height: global.innerHeight,
            cores: global.navigator ? global.navigator.hardwareConcurrency : 4,
            reducedMotion: reducedMotion
          });
          buildPool();
          syncLoop();
        };
        if (mq.addEventListener) mq.addEventListener("change", onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    } catch (e) {}

    return true;
  }

  global.BuamWeather = {
    // constants
    STATES: STATES,
    MODES: MODES,
    STORAGE_KEY: STORAGE_KEY,
    DWELL_MINUTES: DWELL_MINUTES,
    WEIGHTS: WEIGHTS,
    TRANSITION_MS: TRANSITION_MS,
    ACCUM_IN_MS: ACCUM_IN_MS,
    ACCUM_OUT_MS: ACCUM_OUT_MS,
    DEFAULT_STATE: DEFAULT_STATE,
    DEFAULT_MODE: DEFAULT_MODE,
    DEFAULT_INTENSITY: DEFAULT_INTENSITY,

    // pure
    isState: isState,
    isMode: isMode,
    pickNextState: pickNextState,
    dwellMs: dwellMs,
    accumEase: accumEase,
    particleBudget: particleBudget,
    parseStored: parseStored,
    serializeStored: serializeStored,

    // runtime
    init: init,
    setState: setState,
    setMode: setMode,
    getState: function () { return state; },
    getMode: function () { return mode; },
    getIntensity: function () { return intensity; },
    getAccum: function () { return accum; },
    getBudget: function () { return budget; },
    isRunning: function () { return rafId != null; },
    getLoopStarts: function () { return loopStarts; },
    getQuality: function () { return { scale: qualityScale, steps: qualitySteps }; },
    isReducedMotion: function () { return reducedMotion; },
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    syncLoop: syncLoop
  };
})(window);
