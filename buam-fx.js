/* buam-fx.js — shared retro click SFX + ambient sci-fi drone for all buam apps */
(function(global){
  "use strict";
  var MUTE_KEY = "buam-muted";
  var POS_KEY = "buam-track-pos";
  var muted = localStorage.getItem(MUTE_KEY) === "1";

  var ctx = null, sfxGain = null, musicGain = null, musicStarted = false, unlocked = false;
  var MUSIC_VOL = 0.55;

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

  function tone(freq, dur, type, vol, delay){
    var c = ensureCtx();
    if(!c) return;
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
  }

  function sweep(freqFrom, freqTo, dur, type, vol, delay){
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
  }

  function blip(){ tone(680, 0.05, "square", 0.11); }
  function confirmTone(){
    tone(660, 0.06, "square", 0.1);
    tone(990, 0.09, "square", 0.12, 0.05);
  }
  function cancelTone(){ sweep(360, 140, 0.14, "sawtooth", 0.1); }

  /* ---- custom-track storage (IndexedDB, offline, works inside the PWA) ---- */
  var DB_NAME = "buamfx", STORE = "tracks", TRACK_KEY = "custom";
  function openDB(){
    return new Promise(function(resolve, reject){
      if(!window.indexedDB) { reject(new Error("no indexeddb")); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function(){ req.result.createObjectStore(STORE); };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror = function(){ reject(req.error); };
    });
  }
  function getCustomTrack(){
    return openDB().then(function(db){
      return new Promise(function(resolve){
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(TRACK_KEY);
        req.onsuccess = function(){ resolve(req.result || null); };
        req.onerror = function(){ resolve(null); };
        tx.oncomplete = function(){ db.close(); };
      });
    }).catch(function(){ return null; });
  }
  function setCustomTrack(file){
    return openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ blob: file, name: file.name }, TRACK_KEY);
        tx.oncomplete = function(){ db.close(); resolve(); };
        tx.onerror = function(){ db.close(); reject(tx.error); };
      });
    }).then(function(){
      localStorage.removeItem(POS_KEY); // new track picked: start from the beginning
      restartMusic();
    });
  }
  function clearCustomTrack(){
    return openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(TRACK_KEY);
        tx.oncomplete = function(){ db.close(); resolve(); };
        tx.onerror = function(){ db.close(); reject(tx.error); };
      });
    }).then(restartMusic);
  }
  function getCustomTrackInfo(){
    return getCustomTrack().then(function(rec){ return rec ? { name: rec.name } : null; });
  }

  /* ---- music playback: either the user's own track, or the generated ambient ---- */
  var activeStop = null;

  function stopMusic(){
    if(activeStop){ try{ activeStop(); }catch(e){} activeStop = null; }
    musicStarted = false;
  }
  function restartMusic(){
    stopMusic();
    if(unlocked) startMusic();
  }

  function playCustomTrack(blob){
    var c = ctx;
    var url = URL.createObjectURL(blob);
    var audioEl = new Audio(url);
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
    musicGain.gain.setTargetAtTime(muted ? 0 : MUSIC_VOL, c.currentTime, 1.2);

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
      URL.revokeObjectURL(url);
    };
  }

  function playGeneratedAmbient(){
    var c = ctx;
    var stopFns = [];

    // soft space/reverb via a filtered feedback delay
    var delay = c.createDelay(3);
    delay.delayTime.value = 0.6;
    var delayFilter = c.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 2200;
    var feedback = c.createGain();
    feedback.gain.value = 0.38;
    var delayMix = c.createGain();
    delayMix.gain.value = 0.6;
    delay.connect(delayFilter).connect(feedback).connect(delay);
    delay.connect(delayMix).connect(musicGain);

    var dry = c.createGain();
    dry.gain.value = 0.85;
    dry.connect(musicGain);
    dry.connect(delay);

    // faint sustained open-fifth pad, barely audible, just "air"
    [65.41, 98.0].forEach(function(f, i){
      var osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      var g = c.createGain();
      g.gain.value = 0.03;
      var wob = c.createOscillator();
      wob.frequency.value = 0.03 + i * 0.011;
      var wobGain = c.createGain();
      wobGain.gain.value = 0.013;
      wob.connect(wobGain).connect(g.gain);
      osc.connect(g).connect(dry);
      osc.start(); wob.start();
      stopFns.push(function(){ try{ osc.stop(); }catch(e){} try{ wob.stop(); }catch(e){} });
    });

    // sparse, randomly-spaced bell-like notes, minor-pentatonic — Minecraft-ish calm
    var scale = [220.0, 246.94, 261.63, 293.66, 329.63, 392.0, 440.0];
    var noteTimer = null;
    function playNote(){
      if(!muted && ctx){
        var freq = scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.35 ? 0.5 : 1);
        var t0 = c.currentTime;

        var osc = c.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        var g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.5);
        osc.connect(g).connect(dry);
        osc.start(t0);
        osc.stop(t0 + 4.6);

        var osc2 = c.createOscillator();
        osc2.type = "sine";
        osc2.frequency.value = freq * 2.01;
        var g2 = c.createGain();
        g2.gain.setValueAtTime(0.0001, t0);
        g2.gain.exponentialRampToValueAtTime(0.028, t0 + 0.6);
        g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 3);
        osc2.connect(g2).connect(dry);
        osc2.start(t0);
        osc2.stop(t0 + 3.1);
      }
      noteTimer = setTimeout(playNote, 3800 + Math.random() * 5200);
    }
    noteTimer = setTimeout(playNote, 1000);
    stopFns.push(function(){ clearTimeout(noteTimer); });

    musicGain.gain.cancelScheduledValues(c.currentTime);
    musicGain.gain.setTargetAtTime(muted ? 0 : MUSIC_VOL, c.currentTime, 2);
    activeStop = function(){ stopFns.forEach(function(fn){ fn(); }); };
  }

  function startMusic(){
    var c = ensureCtx();
    if(!c || musicStarted) return;
    musicStarted = true;
    getCustomTrack().then(function(rec){
      if(!musicStarted) return; // stopped again before this resolved
      if(rec && rec.blob) playCustomTrack(rec.blob);
      else playGeneratedAmbient();
    });
  }

  function applyMute(){
    if(!ctx) return;
    var now = ctx.currentTime;
    sfxGain.gain.setTargetAtTime(muted ? 0 : 0.5, now, 0.05);
    musicGain.gain.setTargetAtTime(muted ? 0 : MUSIC_VOL, now, 0.4);
  }

  function setMuted(m){
    muted = !!m;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    applyMute();
  }
  function toggleMuted(){ setMuted(!muted); return muted; }
  function isMuted(){ return muted; }

  function unlock(){
    if(unlocked) return;
    unlocked = true;
    ensureCtx();
    if(ctx && ctx.state === "suspended") ctx.resume();
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
    isMuted: isMuted,
    setMuted: setMuted,
    toggleMuted: toggleMuted,
    unlock: unlock,
    setCustomTrack: setCustomTrack,
    clearCustomTrack: clearCustomTrack,
    getCustomTrackInfo: getCustomTrackInfo
  };
})(window);
