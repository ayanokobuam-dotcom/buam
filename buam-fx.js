/* buam-fx.js — shared retro click SFX + bundled background music for all buam apps */
(function(global){
  "use strict";
  var MUTE_KEY = "buam-muted";
  var POS_KEY = "buam-track-pos";
  var VOL_KEY = "buam-music-vol";
  var muted = localStorage.getItem(MUTE_KEY) === "1";

  var ctx = null, sfxGain = null, musicGain = null, musicStarted = false, unlocked = false;
  var storedVol = parseFloat(localStorage.getItem(VOL_KEY));
  var musicVol = isNaN(storedVol) ? 0.55 : Math.min(1, Math.max(0, storedVol));

  function ensureCtx(){
    if(ctx) return ctx;
    try{ ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e){ return null; }
    sfxGain = ctx.createGain();
    sfxGain.gain.value = muted ? 0 : 0.5;
    sfxGain.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(ctx.destination);
    return ctx;
  }

  // every public buamFx call is wrapped so a device-specific Web Audio
  // failure (AudioContext limits, closed context, etc.) can never throw out
  // into a caller's synchronous code — a boot sequence or a task save() must
  // never get bricked just because the optional sound effect failed
  function tone(freq, dur, type, vol, delay){
    try{
      var c = ensureCtx();
      if(!c) return null;
      if(c.state === "suspended") c.resume();
      dur = dur || 0.08; vol = vol == null ? 0.14 : vol;
      var t0 = c.currentTime + (delay || 0);
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = type || "square";
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0001), t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(sfxGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
      return osc;
    }catch(e){ return null; }
  }

  function sweep(freqFrom, freqTo, dur, type, vol, delay){
    try{
      var c = ensureCtx();
      if(!c) return;
      if(c.state === "suspended") c.resume();
      dur = dur || 0.15; vol = vol == null ? 0.14 : vol;
      var t0 = c.currentTime + (delay || 0);
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = type || "sawtooth";
      osc.frequency.setValueAtTime(freqFrom, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(sfxGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }catch(e){}
  }

  function blip(){ tone(680, 0.05, "square", 0.11); }
  function confirmTone(){
    tone(660, 0.06, "square", 0.1);
    tone(990, 0.09, "square", 0.12, 0.05);
  }
  function cancelTone(){ sweep(360, 140, 0.14, "sawtooth", 0.1); }
  function chimeTone(){
    tone(523, 0.09, "square", 0.1);
    tone(659, 0.09, "square", 0.11, 0.09);
    tone(784, 0.14, "square", 0.13, 0.18);
  }

  /* ---- fixed background track, bundled alongside this script ---- */
  var scriptSrc = (document.currentScript && document.currentScript.src) || "";
  var TRACK_URL = scriptSrc ? scriptSrc.replace(/[^/]*$/, "") + "bgm.mp3" : "bgm.mp3";

  var activeStop = null;

  function playTrack(){
    try{
      var c = ctx;
      var audioEl = new Audio(TRACK_URL);
      audioEl.loop = true;

      // resume where the last page left off, so navigating between buam's pages
      // (a full document reload each time) feels continuous instead of restarting
      var resumeAt = parseFloat(localStorage.getItem(POS_KEY) || "0") || 0;
      if(resumeAt > 0){
        audioEl.addEventListener("loadedmetadata", function(){
          if(resumeAt < audioEl.duration) audioEl.currentTime = resumeAt;
        }, { once: true });
      }

      var src = c.createMediaElementSource(audioEl);
      src.connect(musicGain);
      audioEl.play().catch(function(){});
      musicGain.gain.cancelScheduledValues(c.currentTime);
      musicGain.gain.setTargetAtTime(muted ? 0 : musicVol, c.currentTime, 1.2);

      function savePos(){
        try{ localStorage.setItem(POS_KEY, String(audioEl.currentTime)); }catch(e){}
      }
      function onVisibility(){ if(document.hidden) savePos(); }
      var saveTimer = setInterval(function(){ if(!audioEl.paused) savePos(); }, 1500);
      window.addEventListener("pagehide", savePos);
      document.addEventListener("visibilitychange", onVisibility);

      activeStop = function(){
        clearInterval(saveTimer);
        savePos();
        window.removeEventListener("pagehide", savePos);
        document.removeEventListener("visibilitychange", onVisibility);
        audioEl.pause();
        src.disconnect();
      };
    }catch(e){}
  }

  function startMusic(){
    try{
      var c = ensureCtx();
      if(!c || musicStarted) return;
      musicStarted = true;
      playTrack();
    }catch(e){}
  }

  // tears down whatever's currently playing/resumed and starts bgm.mp3 fresh
  // from BOOT_START_AT, wiping the saved resume position — used by the boot
  // intro so every "press ENTER to boot" feels like a real fresh start
  var BOOT_START_AT = 2.5;
  function forceRestartMusic(){
    try{
      var c = ensureCtx();
      if(!c) return;
      if(c.state === "suspended") c.resume();
      if(activeStop) activeStop();
      localStorage.setItem(POS_KEY, String(BOOT_START_AT));
      musicStarted = true;
      playTrack();
    }catch(e){}
  }

  /* ---- Focus Mode ambient sound (rain/forest loops, played alongside bgm) ---- */
  var ambientGain = null, ambientEl = null, ambientVol = 0.5;

  function ensureAmbientGain(){
    var c = ensureCtx();
    if(!c) return null;
    if(!ambientGain){
      ambientGain = c.createGain();
      ambientGain.gain.value = 0;
      ambientGain.connect(c.destination);
    }
    return ambientGain;
  }

  function stopAmbient(){
    if(ambientEl){
      try{ ambientEl.pause(); }catch(e){}
      ambientEl = null;
    }
  }

  // gracefully does nothing if sounds/<name>.mp3 isn't present — Focus Mode's
  // ambient row is optional plumbing until those assets are dropped in
  function playAmbient(name){
    stopAmbient();
    if(!name) return;
    try{
      var c = ensureCtx();
      var g = ensureAmbientGain();
      if(!c || !g) return;
      var base = scriptSrc ? scriptSrc.replace(/[^/]*$/, "") : "";
      var audioEl = new Audio(base + "sounds/" + name + ".mp3");
      audioEl.loop = true;
      audioEl.addEventListener("error", function(){}, { once: true });
      var src = c.createMediaElementSource(audioEl);
      src.connect(g);
      audioEl.play().catch(function(){});
      g.gain.cancelScheduledValues(c.currentTime);
      g.gain.setTargetAtTime(muted ? 0 : ambientVol, c.currentTime, 1.0);
      ambientEl = audioEl;
    }catch(e){}
  }

  function applyMute(){
    if(!ctx) return;
    var now = ctx.currentTime;
    sfxGain.gain.setTargetAtTime(muted ? 0 : 0.5, now, 0.05);
    musicGain.gain.setTargetAtTime(muted ? 0 : musicVol, now, 0.4);
    if(ambientGain) ambientGain.gain.setTargetAtTime(muted ? 0 : ambientVol, now, 0.4);
  }

  function setMuted(m){
    muted = !!m;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    applyMute();
  }
  function toggleMuted(){ setMuted(!muted); return muted; }
  function isMuted(){ return muted; }

  function setVolume(v){
    musicVol = Math.min(1, Math.max(0, v));
    localStorage.setItem(VOL_KEY, String(musicVol));
    if(ctx && !muted){
      musicGain.gain.setTargetAtTime(musicVol, ctx.currentTime, 0.1);
    }
  }
  function getVolume(){ return musicVol; }

  function unlock(){
    if(unlocked) return;
    unlocked = true;
    try{ ensureCtx(); if(ctx && ctx.state === "suspended") ctx.resume(); }catch(e){}
    startMusic();
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function(evt){
    window.addEventListener(evt, unlock, { once: true, passive: true });
  });

  document.addEventListener("click", function(e){
    var el = e.target.closest("button:not([data-fx-skip]), a.card, .classCard");
    if(!el || el.disabled) return;
    blip();
    if(navigator.vibrate) navigator.vibrate(8);
  });

  global.buamFx = {
    tone: tone,
    sweep: sweep,
    blip: blip,
    confirm: confirmTone,
    cancel: cancelTone,
    chime: chimeTone,
    isMuted: isMuted,
    setMuted: setMuted,
    toggleMuted: toggleMuted,
    getVolume: getVolume,
    setVolume: setVolume,
    unlock: unlock,
    forceRestartMusic: forceRestartMusic,
    ambient: playAmbient,
    stopAmbient: stopAmbient
  };
})(window);
