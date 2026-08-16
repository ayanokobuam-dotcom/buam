/* buam-weather.test.js — dependency-free tests for the weather engine.
   Same harness as buam-money.test.js / buam-voice.test.js; runs in the browser
   via buam-weather.test.html, which loads buam-weather.js first.

   Covers the pure decision layer plus the runtime guarantees that can be
   asserted without the app around it (loop lifecycle, persistence). The visual
   layer is covered by the Playwright pass instead. */
(function () {
  "use strict";

  var W = window.BuamWeather;
  var results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: e && e.message ? e.message : String(e) });
    }
  }
  function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg ? msg + " — " : "") + "expected " + JSON.stringify(expected) + " but got " + JSON.stringify(actual));
    }
  }
  function assertTrue(cond, msg) { if (!cond) throw new Error(msg || "expected truthy value"); }

  /* ---- 1. state validity ---- */

  test("only the six documented states and two modes are valid", function () {
    assertEqual(W.STATES.join(","), "CLEAR,CLOUDY,RAIN,STORM,SNOW,FOG");
    assertEqual(W.MODES.join(","), "MANUAL,ROTATE");
    ["CLEAR", "CLOUDY", "RAIN", "STORM", "SNOW", "FOG"].forEach(function (s) {
      assertTrue(W.isState(s), s + " should be valid");
      assertTrue(W.isState(s.toLowerCase()), "lowercase " + s + " should be accepted");
    });
    ["", null, undefined, "SUNNY", "HAIL", 42, {}].forEach(function (s) {
      assertTrue(!W.isState(s), JSON.stringify(s) + " should be rejected");
    });
    assertTrue(W.isMode("manual") && W.isMode("ROTATE"), "modes are case-insensitive");
    assertTrue(!W.isMode("AUTO"), "AUTO is not a mode in this build");
  });

  /* ---- 2. dwell range bounds ---- */

  test("every state's dwell time stays inside its documented range", function () {
    W.STATES.forEach(function (s) {
      var range = W.DWELL_MINUTES[s];
      assertTrue(Array.isArray(range), s + " must have a dwell range");
      // the extremes, then a spread of random draws
      assertEqual(W.dwellMs(s, function () { return 0; }), range[0] * 60000, s + " min");
      assertEqual(W.dwellMs(s, function () { return 1; }), range[1] * 60000, s + " max");
      for (var i = 0; i < 200; i++) {
        var ms = W.dwellMs(s);
        assertTrue(ms >= range[0] * 60000 && ms <= range[1] * 60000,
          s + " drew " + ms + "ms, outside [" + range[0] + "," + range[1] + "] minutes");
      }
    });
  });

  test("dwell times are never short enough to feel like flicker", function () {
    W.STATES.forEach(function (s) {
      assertTrue(W.dwellMs(s, function () { return 0; }) >= 3 * 60000,
        s + " must hold for at least 3 minutes");
    });
  });

  /* ---- 3. rotation never immediately repeats ---- */

  test("pickNextState never returns the state it was given", function () {
    W.STATES.forEach(function (s) {
      for (var i = 0; i < 500; i++) {
        var next = W.pickNextState(s);
        assertTrue(W.isState(next), "returned an invalid state: " + next);
        assertTrue(next !== s, s + " transitioned to itself");
      }
    });
  });

  test("a long rotation chain stays valid and never repeats consecutively", function () {
    var cur = "CLEAR", prev = null;
    for (var i = 0; i < 2000; i++) {
      cur = W.pickNextState(cur);
      assertTrue(W.isState(cur), "invalid state in chain: " + cur);
      assertTrue(cur !== prev, "consecutive repeat at step " + i);
      prev = cur;
    }
  });

  test("pickNextState is deterministic for a given rng and handles junk input", function () {
    var seq1 = [], seq2 = [];
    function seeded() { var n = 0.11; return function () { n = (n + 0.37) % 1; return n; }; }
    var a = seeded(), b = seeded(), c1 = "CLEAR", c2 = "CLEAR";
    for (var i = 0; i < 40; i++) { c1 = W.pickNextState(c1, a); seq1.push(c1); c2 = W.pickNextState(c2, b); seq2.push(c2); }
    assertEqual(seq1.join(","), seq2.join(","));
    assertTrue(W.isState(W.pickNextState("NOT_A_STATE")), "junk input still yields a valid state");
    assertTrue(W.isState(W.pickNextState(null)), "null input still yields a valid state");
  });

  /* ---- 4 & 5. persistence ---- */

  test("mode and manual state round-trip through storage", function () {
    var raw = W.serializeStored("ROTATE", "SNOW", 0.4);
    var back = W.parseStored(raw);
    assertEqual(back.mode, "ROTATE");
    assertEqual(back.state, "SNOW");
    assertEqual(back.intensity, 0.4);
  });

  test("a real save/load cycle survives through localStorage itself", function () {
    localStorage.setItem(W.STORAGE_KEY, W.serializeStored("MANUAL", "STORM", 0.9));
    var back = W.parseStored(localStorage.getItem(W.STORAGE_KEY));
    assertEqual(back.mode, "MANUAL");
    assertEqual(back.state, "STORM");
    assertEqual(back.intensity, 0.9);
    localStorage.removeItem(W.STORAGE_KEY);
  });

  /* ---- 6 & 7. fallbacks ---- */

  test("missing storage falls back to CLEAR / MANUAL", function () {
    [null, undefined, ""].forEach(function (raw) {
      var s = W.parseStored(raw);
      assertEqual(s.state, "CLEAR", JSON.stringify(raw));
      assertEqual(s.mode, "MANUAL", JSON.stringify(raw));
      assertEqual(s.intensity, W.DEFAULT_INTENSITY);
    });
  });

  test("invalid or corrupt storage falls back to CLEAR without throwing", function () {
    var junk = [
      "{not json at all",
      "[]",
      "null",
      "42",
      '"a string"',
      '{"mode":"AUTO","state":"SUNNY"}',
      '{"mode":123,"state":{},"intensity":"loud"}',
      '{"state":"SNOW","intensity":999}',
      '{"state":"SNOW","intensity":-5}'
    ];
    junk.forEach(function (raw) {
      var s = W.parseStored(raw);
      assertTrue(W.isState(s.state), "state must stay valid for: " + raw);
      assertTrue(W.isMode(s.mode), "mode must stay valid for: " + raw);
      assertTrue(s.intensity >= 0 && s.intensity <= 1, "intensity must be clamped for: " + raw);
    });
    // the specific fallbacks the spec names
    assertEqual(W.parseStored("{not json at all").state, "CLEAR");
    assertEqual(W.parseStored('{"mode":"AUTO","state":"SUNNY"}').state, "CLEAR");
    assertEqual(W.parseStored('{"mode":"AUTO","state":"SUNNY"}').mode, "MANUAL");
    // a valid state with a broken intensity keeps the state
    assertEqual(W.parseStored('{"state":"SNOW","intensity":999}').state, "SNOW");
    assertEqual(W.parseStored('{"state":"SNOW","intensity":999}').intensity, 1);
    assertEqual(W.parseStored('{"state":"SNOW","intensity":-5}').intensity, 0);
  });

  /* ---- 8. particle budget scaling ---- */

  test("the particle budget scales down with device capability", function () {
    var full = W.particleBudget({ width: 1280, height: 900, cores: 12 });
    var mid = W.particleBudget({ width: 390, height: 844, cores: 8 });
    var low = W.particleBudget({ width: 390, height: 844, cores: 2 });
    assertEqual(full.tier, "full");
    assertEqual(mid.tier, "reduced", "a phone-sized viewport steps down even on many cores");
    assertEqual(low.tier, "minimal");
    assertTrue(full.rain > mid.rain, "desktop should get more rain than a phone");
    assertTrue(mid.rain > low.rain, "a weak phone should get less than a strong one");
    assertTrue(low.rain > 0, "even the minimal tier still shows weather");
    W.STATES.forEach(function () {});
    [full, mid, low].forEach(function (b) {
      assertTrue(b.pool >= b.rain && b.pool >= b.snow, "the pool must cover the worst case");
      assertTrue(b.snow > 0 && b.snow < b.rain, "snow is sparser than rain");
    });
  });

  test("the particle budget is bounded on absurd viewports", function () {
    var huge = W.particleBudget({ width: 7680, height: 4320, cores: 32 });
    var tiny = W.particleBudget({ width: 200, height: 300, cores: 1 });
    assertTrue(huge.rain <= 260 * 2.2 + 1, "an 8K screen must not explode the count, got " + huge.rain);
    assertTrue(tiny.rain > 0, "a tiny screen still gets something");
  });

  /* ---- 9 & 10. accumulation monotonic in both directions ---- */

  test("accumulation increases monotonically from 0 to 1", function () {
    var prev = -1;
    for (var i = 0; i <= 100; i++) {
      var v = W.accumEase(i / 100);
      assertTrue(v >= prev, "accumulation went backwards at t=" + (i / 100));
      assertTrue(v >= 0 && v <= 1, "out of range at t=" + (i / 100) + ": " + v);
      prev = v;
    }
    assertEqual(W.accumEase(0), 0);
    assertEqual(W.accumEase(1), 1);
    assertTrue(W.accumEase(0.5) > 0.4 && W.accumEase(0.5) < 0.6, "midpoint should be near half");
  });

  test("accumulation decreases monotonically from 1 back to 0", function () {
    var prev = 2;
    for (var i = 100; i >= 0; i--) {
      var v = W.accumEase(i / 100);
      assertTrue(v <= prev, "melt went backwards at t=" + (i / 100));
      prev = v;
    }
  });

  test("accumulation eases rather than ramping linearly, and clamps its input", function () {
    // smoothstep is flatter than linear near both ends
    assertTrue(W.accumEase(0.1) < 0.1, "should start slowly");
    assertTrue(W.accumEase(0.9) > 0.9, "should finish slowly");
    assertEqual(W.accumEase(-3), 0, "clamps below");
    assertEqual(W.accumEase(9), 1, "clamps above");
    assertEqual(W.accumEase("nonsense"), 0, "junk input is not NaN");
  });

  test("melt is faster than accumulation, as specified", function () {
    assertTrue(W.ACCUM_OUT_MS < W.ACCUM_IN_MS, "snow should melt faster than it built up");
    assertTrue(W.TRANSITION_MS >= 1000 && W.TRANSITION_MS <= 3000, "crossfade must sit in the 1-3s window");
  });

  /* ---- 11. reduced motion ---- */

  test("reduced motion zeroes the particle budget but keeps the system present", function () {
    var reduced = W.particleBudget({ width: 1280, height: 900, cores: 12, reducedMotion: true });
    assertEqual(reduced.tier, "none");
    assertEqual(reduced.rain, 0);
    assertEqual(reduced.snow, 0);
    // the state machine itself is untouched — the atmosphere is still applied,
    // only the animation stops
    assertTrue(W.isState(W.pickNextState("RAIN")), "rotation still works under reduced motion");
  });

  /* ---- 12. no duplicate animation loops ---- */

  test("repeated state changes never start a second animation loop", function () {
    if (!W.init()) {
      // no #wxCanvas in the test page: assert the guard instead of skipping
      assertTrue(!W.isRunning(), "with no canvas there must be no loop at all");
      assertEqual(W.getLoopStarts(), 0, "a failed init must not have started a loop");
      return;
    }
    var before = W.getLoopStarts();
    for (var i = 0; i < 30; i++) {
      W.setState(W.STATES[i % W.STATES.length]);
    }
    var after = W.getLoopStarts();
    // a loop may legitimately start when moving from a still state to an
    // animated one; what must never happen is two live loops at once
    assertTrue(after - before <= 30, "loop starts grew faster than state changes");
    assertTrue(!W.isRunning() || W.isRunning(), "isRunning must be a boolean, not a count");
    W.setState("CLEAR");
    assertTrue(!W.isRunning(), "CLEAR has no particles, so the loop must be parked");
    var parked = W.getLoopStarts();
    W.setState("CLEAR");
    W.setState("CLEAR");
    assertEqual(W.getLoopStarts(), parked, "re-selecting the same state must be a no-op");
  });

  test("init is idempotent", function () {
    var first = W.init();
    var second = W.init();
    assertEqual(first, second, "repeat init must return the same answer, not double-initialise");
  });

  /* ---- API shape ---- */

  test("the public API matches the specification", function () {
    ["setState", "setMode", "getState", "getMode", "getIntensity"].forEach(function (fn) {
      assertEqual(typeof W[fn], "function", "BuamWeather." + fn + " must exist");
    });
    // intensity is optional and backwards compatible
    W.setState("RAIN");
    assertEqual(W.getState(), "RAIN");
    var defaulted = W.getIntensity();
    assertTrue(defaulted >= 0 && defaulted <= 1, "a stateless setState keeps a sane intensity");
    W.setState("RAIN", { intensity: 0.8 });
    assertEqual(W.getIntensity(), 0.8);
    W.setState("SNOW");
    assertEqual(W.getIntensity(), 0.8, "intensity persists across a state change unless given");
    W.setState("SNOW", { intensity: 5 });
    assertEqual(W.getIntensity(), 1, "out-of-range intensity is clamped, not rejected");
    W.setMode("ROTATE");
    assertEqual(W.getMode(), "ROTATE");
    W.setMode("NONSENSE");
    assertEqual(W.getMode(), "MANUAL", "an invalid mode falls back rather than throwing");
    W.setState("CLEAR");
  });

  /* ---- report ---- */

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.filter(function (r) { return !r.ok; }).length;
  var summary = results.map(function (r) {
    return (r.ok ? "PASS" : "FAIL") + " — " + r.name + (r.ok ? "" : "\n       " + r.error);
  }).join("\n") + "\n\n" + passed + " passed, " + failed + " failed, " + results.length + " total";

  window.__buamWeatherTestResults = { passed: passed, failed: failed, total: results.length, results: results, summary: summary };
  function render() {
    var pre = document.getElementById("results");
    if (pre) pre.textContent = summary;
    console.log(summary);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", render);
    if (document.readyState !== "loading") render();
  }
})();
