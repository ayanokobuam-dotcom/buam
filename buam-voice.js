/* B.U.A.M. voice engine — pure logic, no DOM, no Web Speech, no network.
 *
 * Everything here is a deterministic function of its arguments (dates take an
 * explicit `now`, the picker takes an explicit rng), so the whole engine is
 * unit-testable the same way buam-money.js is. index.html owns the microphone,
 * the DOM and the app actions; this file only decides *what was meant* and
 * *what to say back*.
 *
 * Design notes grounded in real device measurements (see mic-test.html):
 *   - input is Thai. On the target device Thai commands transcribe at
 *     0.99-1.00 while English ones collapse ("add task" -> "AirTag"), so the
 *     command vocabulary is Thai only.
 *   - replies are English, matching the app's existing terminal identity and
 *     the English voice already selected in buam-fx.js.
 *   - correct transcripts scored 0.82-1.00 and misheard ones 0.49-0.63, which
 *     is where the confidence bands below come from.
 *   - speech recognition inserts spaces unpredictably in Thai, so every
 *     keyword test runs against a whitespace-stripped copy of the transcript.
 */
(function (global) {
  "use strict";

  /* ================================================================
   * confidence bands
   * ================================================================ */

  var CONFIDENCE = {
    // below this the transcript is more likely wrong than right — ask again
    discard: 0.55,
    // above this act without asking
    sure: 0.75
  };

  // an expense at or above this always asks for confirmation, however
  // confident the transcript was: a misheard big number is expensive to undo
  var CONFIRM_BAHT = 1000;

  // intents that change stored data. Everything else is read-only and safe to
  // run on a merely plausible transcript.
  var WRITE_INTENTS = {
    "task.add": true,
    "task.done": true,
    "money.add": true,
    "timer.start": true
  };

  function isWriteIntent(intent) {
    return !!WRITE_INTENTS[intent];
  }

  /* Decide what to do with a parsed intent given how sure the recognizer was.
     Returns "retry" | "confirm" | "act". */
  function gate(intent, score, params) {
    if (typeof score === "number" && score < CONFIDENCE.discard) return "retry";
    if (intent === "money.add" && params && params.amount >= CONFIRM_BAHT) return "confirm";
    if (typeof score === "number" && score < CONFIDENCE.sure && isWriteIntent(intent)) return "confirm";
    return "act";
  }

  /* ================================================================
   * text normalization
   * ================================================================ */

  /* Thai speech recognition spaces words inconsistently — "เปิดปฏิทิน" comes
     back joined while "กาแฟ 60 บาท" comes back split. Keyword matching uses
     the compact form; extraction uses the spaced form so titles keep their
     word breaks. */
  function normalize(text) {
    return String(text == null ? "" : text)
      .replace(/[​﻿]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compact(text) {
    return normalize(text).replace(/\s+/g, "");
  }

  function hasAny(haystack, needles) {
    for (var i = 0; i < needles.length; i++) {
      if (haystack.indexOf(needles[i]) !== -1) return true;
    }
    return false;
  }

  /* Removes a phrase that was recognised inside a longer string — used to lift
     a date out of a task title. The phrase may have been matched against the
     whitespace-stripped copy, so a second pass compares compacted text. */
  function stripPhrase(text, phrase) {
    var result = normalize(String(text).replace(phrase, " "));
    if (compact(result).indexOf(compact(phrase)) !== -1) {
      result = normalize(compact(result).replace(compact(phrase), " "));
    }
    return result;
  }

  /* ================================================================
   * Thai numerals
   * ================================================================ */

  var THAI_DIGIT = {
    "ศูนย์": 0, "หนึ่ง": 1, "เอ็ด": 1, "สอง": 2, "ยี่": 2, "สาม": 3, "สี่": 4,
    "ห้า": 5, "หก": 6, "เจ็ด": 7, "แปด": 8, "เก้า": 9
  };
  var THAI_UNIT = { "สิบ": 10, "ร้อย": 100, "พัน": 1000, "หมื่น": 10000, "แสน": 100000, "ล้าน": 1000000 };

  var THAI_NUM_RE = new RegExp(
    "(?:" + Object.keys(THAI_DIGIT).concat(Object.keys(THAI_UNIT)).join("|") + ")+"
  );

  /* "ห้าสิบห้า" -> 55, "สองร้อยห้าสิบ" -> 250, "ยี่สิบเอ็ด" -> 21.
     Units are positional multipliers, except ล้าน which scales what came
     before it. Returns null if nothing numeric was found. */
  function parseThaiNumber(text) {
    var s = compact(text);
    if (!s) return null;
    var total = 0, cur = 0, matched = false, i = 0;

    while (i < s.length) {
      var hit = null;
      // longest-first so "ยี่" is not eaten before "ยี่สิบ" is considered
      for (var len = 4; len >= 1; len--) {
        var chunk = s.substr(i, len);
        if (THAI_DIGIT[chunk] !== undefined) { hit = { kind: "d", v: THAI_DIGIT[chunk], len: len }; break; }
        if (THAI_UNIT[chunk] !== undefined) { hit = { kind: "u", v: THAI_UNIT[chunk], len: len }; break; }
      }
      if (!hit) { i++; continue; }
      matched = true;
      if (hit.kind === "d") {
        cur = hit.v;
      } else if (hit.v === 1000000) {
        total = (total + cur) * 1000000;
        cur = 0;
      } else {
        total += (cur || 1) * hit.v;
        cur = 0;
      }
      i += hit.len;
    }
    if (!matched) return null;
    return total + cur;
  }

  /* ================================================================
   * dates
   * ================================================================ */

  /* Same local-date convention as localDateStr() in index.html. Date maths
     stays in local time and never touches the app's storage format. */
  function toDateStr(d) {
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function addDays(d, n) {
    var out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    out.setDate(out.getDate() + n);
    return out;
  }

  var WEEKDAYS = [
    { names: ["วันอาทิตย์", "อาทิตย์"], dow: 0 },
    { names: ["วันจันทร์", "จันทร์"], dow: 1 },
    { names: ["วันอังคาร", "อังคาร"], dow: 2 },
    { names: ["วันพุธ", "พุธ"], dow: 3 },
    { names: ["วันพฤหัสบดี", "วันพฤหัส", "พฤหัส"], dow: 4 },
    { names: ["วันศุกร์", "ศุกร์"], dow: 5 },
    { names: ["วันเสาร์", "เสาร์"], dow: 6 }
  ];

  var MONTHS = [
    { names: ["มกราคม", "มกรา", "ม.ค."], m: 0 },
    { names: ["กุมภาพันธ์", "กุมภา", "ก.พ."], m: 1 },
    { names: ["มีนาคม", "มีนา", "มี.ค."], m: 2 },
    { names: ["เมษายน", "เมษา", "เม.ย."], m: 3 },
    { names: ["พฤษภาคม", "พฤษภา", "พ.ค."], m: 4 },
    { names: ["มิถุนายน", "มิถุนา", "มิ.ย."], m: 5 },
    { names: ["กรกฎาคม", "กรกฎา", "ก.ค."], m: 6 },
    { names: ["สิงหาคม", "สิงหา", "ส.ค."], m: 7 },
    { names: ["กันยายน", "กันยา", "ก.ย."], m: 8 },
    { names: ["ตุลาคม", "ตุลา", "ต.ค."], m: 9 },
    { names: ["พฤศจิกายน", "พฤศจิกา", "พ.ย."], m: 10 },
    { names: ["ธันวาคม", "ธันวา", "ธ.ค."], m: 11 }
  ];

  /* Speech recognition writes numbers as digits most of the time, but not
     always — "วันที่ยี่สิบ" comes back spelled out often enough to matter. */
  var THAI_UNITS = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
  var THAI_NUMBERS = (function () {
    var map = {}, n;
    for (n = 1; n <= 9; n++) map[THAI_UNITS[n]] = n;
    map["สิบ"] = 10;
    for (n = 11; n <= 19; n++) map["สิบ" + THAI_UNITS[n - 10]] = n;
    map["สิบเอ็ด"] = 11;
    map["ยี่สิบ"] = 20;
    for (n = 21; n <= 29; n++) map["ยี่สิบ" + THAI_UNITS[n - 20]] = n;
    map["ยี่สิบเอ็ด"] = 21;
    map["สามสิบ"] = 30;
    map["สามสิบหนึ่ง"] = 31;
    map["สามสิบเอ็ด"] = 31;
    return map;
  })();

  function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function alternation(words) {
    return words.slice().sort(function (a, b) { return b.length - a.length; })
      .map(escapeRe).join("|");
  }

  var MONTH_NAMES = MONTHS.reduce(function (acc, mo) { return acc.concat(mo.names); }, []);
  var MONTH_RE = alternation(MONTH_NAMES);
  var COUNT_RE = "\\d{1,2}|" + alternation(Object.keys(THAI_NUMBERS));
  var WEEKDAY_NAMES = WEEKDAYS.reduce(function (acc, w) { return acc.concat(w.names); }, []);
  var WEEKDAY_RE = alternation(WEEKDAY_NAMES);

  function readCount(token) {
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    var n = THAI_NUMBERS[token];
    return typeof n === "number" ? n : NaN;
  }

  function monthIndex(name) {
    for (var i = 0; i < MONTHS.length; i++) {
      if (MONTHS[i].names.indexOf(name) !== -1) return MONTHS[i].m;
    }
    return -1;
  }

  /* People write years three ways: CE in full (2026), BE in full (2569) and BE
     shortened to two digits (69). A two-digit year is genuinely ambiguous, so
     both readings are computed and the one that lands in a sensible window
     around today wins — "26" is 2026, "69" is 2569 = 2026. */
  function resolveYear(digits, base) {
    var y = parseInt(digits, 10);
    if (isNaN(y)) return base.getFullYear();
    if (digits.length >= 3) return y >= 2400 ? y - 543 : y;
    var cur = base.getFullYear();
    var ce = 2000 + y, be = 1957 + y;          // 2500 + y - 543
    var okCe = ce >= cur - 1 && ce <= cur + 50;
    var okBe = be >= cur - 1 && be <= cur + 50;
    if (okCe && okBe) return Math.min(ce, be);
    return okBe ? be : ce;
  }

  /* Finds a date expression anywhere in the text.
     Returns { date: "YYYY-MM-DD", matched: "<the phrase>" } or null, so the
     caller can strip the phrase out of a task title. `matched` is always the
     literal run of text that was consumed, so stripping it never leaves half a
     phrase — or eats a character the user meant to keep — behind. */
  function parseThaiDate(text, now) {
    var raw = normalize(text);
    var s = compact(raw);
    if (!s) return null;
    var base = now instanceof Date ? now : new Date();
    var today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    var m, day, mon, year, target;

    function found(d, phrase) { return { date: toDateStr(d), matched: phrase }; }

    function valid(d, expectDay, expectMon) {
      return d.getDate() === expectDay && (expectMon == null || d.getMonth() === expectMon);
    }

    // try the text as spoken, then with the spaces closed up — speech
    // recognition is inconsistent about where it puts them
    function scan(re) { return raw.match(re) || s.match(re); }

    /* ---- fully written out: 2026-08-20 ---- */
    m = scan(/(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/);
    if (m) {
      year = parseInt(m[1], 10);
      target = new Date(year >= 2400 ? year - 543 : year, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
      if (valid(target, parseInt(m[3], 10), parseInt(m[2], 10) - 1)) return found(target, m[0]);
    }

    /* ---- numeric, Thai order: 20/8, 20/8/2569, 20-8-2569.
       A dash is only read as a date separator when a year is there too: plain
       "3-4" is far more often a range ("อ่านบทที่ 3-4") than the 3rd of April. */
    m = scan(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/)
      || scan(/(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{2,4})/);
    if (m) {
      day = parseInt(m[1], 10);
      mon = parseInt(m[2], 10) - 1;
      if (day >= 1 && day <= 31 && mon >= 0 && mon <= 11) {
        year = m[3] ? resolveYear(m[3], base) : base.getFullYear();
        target = new Date(year, mon, day);
        if (valid(target, day, mon)) {
          // a bare day/month that has already gone by means next year
          if (!m[3] && target < today) target = new Date(year + 1, mon, day);
          return found(target, m[0]);
        }
      }
    }

    /* ---- day + month name: "20 สิงหาคม", "วันที่ 5 ก.พ. 2569" ---- */
    m = scan(new RegExp(
      "(?:วันที่\\s*)?(" + COUNT_RE + ")\\s*(?:เดือน\\s*)?(" + MONTH_RE + ")(?:\\s*(?:ปี\\s*)?(\\d{2,4}))?"
    ));
    if (m) {
      day = readCount(m[1]);
      mon = monthIndex(m[2]);
      if (day >= 1 && day <= 31 && mon >= 0) {
        year = m[3] ? resolveYear(m[3], base) : base.getFullYear();
        target = new Date(year, mon, day);
        if (valid(target, day, mon)) {
          if (!m[3] && target < today) target = new Date(year + 1, mon, day);
          return found(target, m[0]);
        }
      }
    }

    /* ---- counted offsets: "อีก 3 วัน", "อีกสองอาทิตย์" ---- */
    m = scan(new RegExp("อีก\\s*(" + COUNT_RE + ")\\s*(วัน|สัปดาห์|อาทิตย์|เดือน)"));
    if (m) {
      var n = readCount(m[1]);
      if (n >= 1) {
        if (m[2] === "วัน") return found(addDays(base, n), m[0]);
        if (m[2] === "เดือน") {
          return found(new Date(base.getFullYear(), base.getMonth() + n, base.getDate()), m[0]);
        }
        return found(addDays(base, n * 7), m[0]);
      }
    }

    /* ---- a day inside next month: "วันที่ 5 เดือนหน้า" ---- */
    m = scan(new RegExp("(?:วันที่\\s*)?(" + COUNT_RE + ")\\s*เดือนหน้า"))
      || scan(new RegExp("เดือนหน้า\\s*(?:วันที่\\s*)?(" + COUNT_RE + ")"));
    if (m) {
      day = readCount(m[1]);
      if (day >= 1 && day <= 31) {
        target = new Date(base.getFullYear(), base.getMonth() + 1, day);
        if (target.getDate() === day) return found(target, m[0]);
      }
    }

    // relative days — check the longer phrases first
    m = scan(/มะรืน(?:นี้)?/);
    if (m) return found(addDays(base, 2), m[0]);
    m = scan(/พรุ่งนี้/);
    if (m) return found(addDays(base, 1), m[0]);
    m = scan(/เมื่อวาน(?:นี้)?/);
    if (m) return found(addDays(base, -1), m[0]);
    m = scan(/วันนี้/);
    if (m) return found(base, m[0]);

    m = scan(/(?:อาทิตย์|สัปดาห์)\s*(?:หน้า|ถัดไป)/);
    if (m) return found(addDays(base, 7), m[0]);

    m = scan(/สิ้นเดือน(?:นี้)?/);
    if (m) return found(new Date(base.getFullYear(), base.getMonth() + 1, 0), m[0]);
    m = scan(/เดือนหน้า/);
    if (m) return found(new Date(base.getFullYear(), base.getMonth() + 1, base.getDate()), m[0]);

    /* named weekday -> the next time that day comes round (never today).
       A trailing "นี้"/"หน้า" is swallowed into the matched phrase so it does
       not survive in the task title; it does not shift the date. */
    m = scan(new RegExp("(" + WEEKDAY_RE + ")\\s*(?:นี้|หน้า|ถัดไป)?"));
    if (m) {
      for (var i = 0; i < WEEKDAYS.length; i++) {
        if (WEEKDAYS[i].names.indexOf(m[1]) !== -1) {
          var delta = (WEEKDAYS[i].dow - base.getDay() + 7) % 7;
          if (delta === 0) delta = 7;
          return found(addDays(base, delta), m[0]);
        }
      }
    }

    // "วันที่ 20" -> the 20th of this month, or next month if already past
    m = scan(new RegExp("วันที่\\s*(" + COUNT_RE + ")"));
    if (m) {
      day = readCount(m[1]);
      if (day >= 1 && day <= 31) {
        target = new Date(base.getFullYear(), base.getMonth(), day);
        if (target.getDate() !== day || target < today) {
          target = new Date(base.getFullYear(), base.getMonth() + 1, day);
        }
        return found(target, m[0]);
      }
    }
    return null;
  }

  /* ================================================================
   * amounts and categories
   * ================================================================ */

  var MONEY_VERBS = ["จ่าย", "ซื้อ", "ค่า", "เสียเงิน", "ใช้ไป", "หมดไป", "บันทึกรายจ่าย"];

  /* Returns { amount, note, matched } or null.
     Digits are the primary form — the target device transcribes "กาแฟ 60 บาท"
     with an Arabic 60 — with Thai numerals as a fallback. A bare number only
     counts as money when the sentence also carries a spending verb, so
     "จับเวลา 25 นาที" can never be read as an expense. */
  function parseAmount(text) {
    var raw = normalize(text);
    if (!raw) return null;
    var s = compact(raw);

    var m = raw.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:บาท|฿)/);
    if (!m) m = s.match(/(\d[\d,]*(?:\.\d+)?)(?:บาท|฿)/);
    if (m) {
      return { amount: Number(m[1].replace(/,/g, "")), matched: m[0] };
    }

    // Thai-word amount, e.g. "กาแฟหกสิบบาท" with no digits
    if (/บาท|฿/.test(s)) {
      var head = s.split(/บาท|฿/)[0];
      var tm = head.match(new RegExp(THAI_NUM_RE.source + "$"));
      if (tm) {
        var v = parseThaiNumber(tm[0]);
        if (v != null && v > 0) return { amount: v, matched: tm[0] + "บาท" };
      }
    }

    // bare number, only with an explicit spending verb
    if (hasAny(s, MONEY_VERBS)) {
      var bm = raw.match(/(\d[\d,]*(?:\.\d+)?)/);
      if (bm) return { amount: Number(bm[1].replace(/,/g, "")), matched: bm[0] };
    }
    return null;
  }

  /* Keyword -> category hints. Matched against the *live* category list by
     name, because categories are user-editable; the hint only decides which
     name to look for. */
  var CATEGORY_HINTS = [
    { words: ["กาแฟ", "ข้าว", "อาหาร", "กิน", "น้ำ", "ขนม", "หิว", "ร้านอาหาร", "ชา", "นม"], name: "อาหาร" },
    { words: ["รถ", "แท็กซี่", "วิน", "รถไฟฟ้า", "bts", "mrt", "น้ำมัน", "เดินทาง", "ค่ารถ", "แกร็บ", "grab"], name: "เดินทาง" },
    { words: ["ของใช้", "สบู่", "ยาสีฟัน", "กระดาษ", "ซัก", "ทิชชู"], name: "ของใช้" },
    { words: ["หนังสือ", "เรียน", "คอร์ส", "ติว", "ค่าเทอม", "อุปกรณ์การเรียน"], name: "การเรียน" },
    { words: ["ai", "software", "แอป", "subscription", "สมัคร", "โปรแกรม"], name: "AI / Software" },
    { words: ["หนัง", "เกม", "เที่ยว", "บันเทิง", "คอนเสิร์ต", "ดูหนัง"], name: "ความบันเทิง" },
    { words: ["แฟน", "ของขวัญ", "เดท"], name: "แฟน/ความสัมพันธ์" }
  ];

  /* categories: the money module's shape, { expense: [{id, name, archived}] }.
     Falls back to the first non-archived expense category, then exp-other. */
  function guessCategory(note, categories) {
    var list = (categories && categories.expense) || [];
    var active = list.filter(function (c) { return !c.archived; });
    var s = compact(note).toLowerCase();

    for (var i = 0; i < CATEGORY_HINTS.length; i++) {
      var hint = CATEGORY_HINTS[i];
      if (!hasAny(s, hint.words)) continue;
      var byName = active.filter(function (c) { return compact(c.name) === compact(hint.name); })[0];
      if (byName) return byName.id;
    }
    var other = active.filter(function (c) { return /อื่น/.test(c.name); })[0];
    if (other) return other.id;
    return active.length ? active[0].id : "exp-other";
  }

  /* ================================================================
   * task lookup
   * ================================================================ */

  /* Character-bigram overlap (Dice). Thai has no word boundaries and the
     recognizer will not reproduce a title exactly, so this compares the shape
     of the two strings rather than requiring one to contain the other. */
  function bigrams(s) {
    var out = {};
    for (var i = 0; i < s.length - 1; i++) {
      var g = s.substr(i, 2);
      out[g] = (out[g] || 0) + 1;
    }
    return out;
  }

  function diceCoefficient(a, b) {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    var A = bigrams(a), B = bigrams(b), k, na = 0, nb = 0, inter = 0;
    for (k in A) na += A[k];
    for (k in B) nb += B[k];
    if (!na || !nb) return 0;
    for (k in A) if (B[k]) inter += Math.min(A[k], B[k]);
    return (2 * inter) / (na + nb);
  }

  /* 0..1, how well a spoken fragment identifies a task title.
     A keyword sitting inside the title scores highest — that is the whole point
     of the feature: "เสร็จแล้ว การบ้าน" should find "ส่งการบ้านเลข 5 ข้อ" without
     the user reciting it. Below that, fuzzy shape matching catches the cases
     where the recognizer heard something close but not identical. */
  var MATCH_MIN = 0.42;       // anything weaker is not a match at all
  var MATCH_AMBIGUOUS = 0.08; // two candidates this close are worth asking about

  function scoreTitleMatch(query, title) {
    var q = compact(query).toLowerCase();
    var t = compact(title).toLowerCase();
    if (!q || !t) return 0;
    if (q === t) return 1;
    // a spoken keyword contained in the title; longer keywords are stronger
    if (t.indexOf(q) !== -1) return 0.80 + 0.15 * (q.length / t.length);
    if (q.indexOf(t) !== -1) return 0.75 + 0.15 * (t.length / q.length);
    return diceCoefficient(q, t) * 0.85;
  }

  /* Ranked candidates, best first. Unfinished tasks get a small nudge so they
     win ties against something already ticked off. */
  function findTaskMatches(query, tasks) {
    if (!query || !tasks || !tasks.length) return [];
    var scored = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t || !t.title) continue;
      var s = scoreTitleMatch(query, t.title);
      if (s <= 0) continue;
      scored.push({ task: t, score: +(s + (t.done ? 0 : 0.03)).toFixed(4) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.filter(function (m) { return m.score >= MATCH_MIN; });
  }

  /* true when the top two candidates are too close to choose between, so the
     caller can ask instead of guessing wrong on the user's data */
  function isAmbiguousMatch(matches) {
    return matches.length > 1 && (matches[0].score - matches[1].score) < MATCH_AMBIGUOUS;
  }

  function findTaskByTitle(title, tasks) {
    var m = findTaskMatches(title, tasks);
    return m.length ? m[0].task : null;
  }

  /* ================================================================
   * intent router
   * ================================================================ */

  var CHAT_RULES = [
    /* ---- specific forms first ----
       Each of these is a longer phrase whose keyword sits inside a shorter,
       more general one further down: "เหงาไหม" asks how BUAM feels but contains
       "เหงา"; "หิวแต่ไม่รู้จะกิน" contains "หิว"; "หลับฝันดี" contains "ฝันดี".
       Listed later they were unreachable — the general rule always won. */
    { intent: "chat.feelings", words: ["มีความรู้สึกไหม", "เหงาไหม", "เบื่อไหม", "เจ็บไหม"] },
    { intent: "chat.whatToEat", words: ["กินอะไรดี", "หิวแต่ไม่รู้จะกิน", "แนะนำอาหาร"] },
    { intent: "chat.goodnight", words: ["จะนอนแล้ว", "เข้านอน", "นอนก่อน", "หลับฝันดี", "ฝันดี"] },
    { intent: "chat.weatherAsk", words: ["ฝนจะตกไหม", "ฝนตกไหม", "ฝนตกมั้ย", "อากาศเป็นไง", "อุณหภูมิ", "พยากรณ์"] },

    { intent: "chat.whoAreYou", words: ["เป็นใคร", "คือใคร", "ชื่ออะไร", "แนะนำตัว"] },
    /* bare "เป็นไง" is exact-only: "อากาศเป็นไง" is a question about the
       weather, not about how BUAM is doing */
    { intent: "chat.howAreYou", words: ["เป็นไงบ้าง", "เป็นยังไงบ้าง", "สบายดีไหม", "สบายดีมั้ย"],
      exact: ["เป็นไง"] },
    { intent: "chat.thanks", words: ["ขอบคุณ", "ขอบใจ", "แต๊งกิ้ว"] },
    { intent: "chat.praise", words: ["เก่ง", "เยี่ยม", "สุดยอด", "ดีมาก", "เจ๋ง", "แจ่ม", "โคตรดี"] },
    { intent: "chat.love", words: ["รักนาย", "รักเธอ", "คิดถึง", "รักเลย"] },
    { intent: "chat.joke", words: ["เล่าเรื่องตลก", "มุกตลก", "เล่ามุก", "ขำ", "เล่าอะไรหน่อย"] },
    /* "บาย" is a substring of "ไม่สบาย", so it can only match as the whole
       utterance — otherwise saying you feel ill reads as saying goodbye */
    { intent: "chat.bye", words: ["ไปก่อน", "ลาก่อน", "ไว้เจอกัน", "ราตรีสวัสดิ์"],
      exact: ["บาย", "บายๆ", "บ๊ายบาย"] },
    { intent: "chat.tired", words: ["เหนื่อย", "ล้า", "เพลีย", "หมดแรง", "หมดพลัง", "ไม่ไหวแล้ว"] },
    /* "ท้อ" sits inside "ปวดท้อง" and "ท้องร้อง", so it only counts as the
       whole utterance; the longer forms stay as ordinary keywords */
    { intent: "chat.down", words: ["เศร้า", "เสียใจ", "ท้อแท้", "ท้อจัง", "แย่จัง", "ไม่โอเค", "ร้องไห้", "เครียด"],
      exact: ["ท้อ"] },
    { intent: "chat.happy", words: ["ดีใจ", "มีความสุข", "สนุก", "ฟินมาก", "แฮปปี้"] },
    { intent: "chat.bored", words: ["เบื่อ", "ไม่มีอะไรทำ", "ว่างจัง"] },
    { intent: "chat.hungry", words: ["หิว", "อยากกิน", "ท้องร้อง"] },
    { intent: "chat.sleepy", words: ["ง่วง", "อยากนอน", "นอนไม่หลับ", "ไม่ได้นอน"] },
    { intent: "chat.motivate", words: ["ไม่อยากทำ", "ขี้เกียจ", "ทำไม่ไหว", "ให้กำลังใจ", "ผัดวันประกันพรุ่ง"] },
    { intent: "chat.talk", words: ["คุยกัน", "คุยด้วย", "อยากคุย", "เหงา", "อยู่เป็นเพื่อน"] },
    { intent: "chat.greeting", words: ["สวัสดี", "หวัดดี", "ดีจ้า", "ว่าไง", "เฮ้", "ฮัลโหล"] },

    /* ---- second wave: the things people actually say to something that
       listens every day, rather than only the polite openers ---- */
    { intent: "chat.morning", words: ["อรุณสวัสดิ์", "ตื่นแล้ว", "เพิ่งตื่น", "เช้าแล้ว"] },
    // proud before stress: "สอบผ่านแล้ว" contains "สอบ", and being congratulated
    // for passing matters more than being consoled for having an exam
    { intent: "chat.proud", words: ["ทำได้แล้ว", "สำเร็จแล้ว", "ผ่านแล้ว", "สอบผ่าน", "ภูมิใจ"] },
    { intent: "chat.stress", words: ["งานเยอะ", "เรียนหนัก", "สอบ", "ยุ่งมาก", "ทำไม่ทัน", "เดดไลน์", "งานล้น"] },
    { intent: "chat.encourage", words: ["ขอกำลังใจ", "เป็นห่วง", "อวยพร", "ขอให้โชคดี", "ลุ้นให้หน่อย"] },
    { intent: "chat.sick", words: ["ไม่สบาย", "ปวดหัว", "ป่วย", "เป็นไข้", "ปวดท้อง", "เจ็บคอ"] },
    { intent: "chat.angry", words: ["โมโห", "หงุดหงิด", "เซ็ง", "รำคาญ", "โกรธ", "ฉุน"] },
    { intent: "chat.vent", words: ["โคตร", "เหี้ย", "ห่า", "แม่ง", "ชิบหาย", "บ้าเอ๊ย"] },
    { intent: "chat.music", words: ["เปิดเพลง", "เพลงอะไรดี", "ฟังเพลง", "แนะนำเพลง"] },
    { intent: "chat.weatherTalk", words: ["ฝนตก", "ร้อนจัง", "หนาวจัง", "อากาศดี", "อากาศแย่", "ฟ้าร้อง"] },
    { intent: "chat.miss", words: ["หายไปไหน", "ไม่ได้คุยนาน", "นานแล้วนะ"] },
    { intent: "chat.sorry", words: ["ขอโทษ", "ผิดเอง", "โทษที"] },
    { intent: "chat.compliment", words: ["สวยจัง", "เท่จัง", "หน้าตาดี", "ดูดีจัง", "สีสวย"] },
    { intent: "chat.doubt", words: ["จริงเหรอ", "แน่ใจนะ", "โกหกรึเปล่า", "มั่ว"] },
    { intent: "chat.smallTalk", words: ["ทำอะไรอยู่", "ว่างไหม", "อยู่ไหม", "ยังอยู่รึเปล่า"] },
    { intent: "chat.age", words: ["อายุเท่าไหร่", "เกิดเมื่อไหร่", "แก่รึยัง"] },
    { intent: "chat.study", words: ["อ่านหนังสือไม่เข้าหัว", "จำไม่ได้", "สมาธิสั้น", "ไม่มีสมาธิ"] },
    { intent: "chat.money", words: ["ไม่มีเงิน", "ถังแตก", "เงินหมด", "จนมาก"] },
    { intent: "chat.future", words: ["อนาคต", "ไม่รู้จะทำอะไร", "หลงทาง", "ชีวิตนี้"] }
  ];

  /* transcript -> { intent, params, raw }.
     Rules run in order, most specific first: a query about money must beat
     plain navigation to the money screen, and "เพิ่มงาน" must beat "งาน". */
  function parseIntent(transcript, opts) {
    opts = opts || {};
    var raw = normalize(transcript);
    var s = compact(raw);
    var now = opts.now instanceof Date ? opts.now : new Date();
    var categories = opts.categories || null;

    if (!s) return { intent: "none", params: {}, raw: raw };

    function out(intent, params) {
      return { intent: intent, params: params || {}, raw: raw };
    }

    /* ---- yes / no, for answering a confirmation ---- */
    if (/^(ใช่|ได้|เอา|ตกลง|โอเค|โอเก|ยืนยัน|เอาเลย|ใช่เลย)$/.test(s)) return out("confirm.yes");
    if (/^(ไม่|ไม่เอา|ยกเลิก|ไม่ใช่|หยุด|ไม่ต้อง)$/.test(s)) return out("confirm.no");

    /* ---- add a task ----
       An explicit add command is unambiguous, so it is tested before the
       question and briefing keywords. Without this, "เพิ่มงานส่งรายงาน" was
       read as a request for a briefing, because it contains "รายงาน". */
    var addSrc = raw;
    var addM = raw.match(/(?:เพิ่ม|สร้าง|จด|ใส่|บันทึก)\s*(?:งาน|ทาสก์|ทาส์ก|task)\s*(.*)$/i);
    if (!addM) {
      var addC = s.match(/(?:เพิ่ม|สร้าง|จด|ใส่|บันทึก)(?:งาน|ทาสก์|ทาส์ก|task)(.*)$/i);
      if (addC) { addM = addC; addSrc = s; }
    }
    if (addM) {
      var rest = normalize(addM[1] || "");
      var due = parseThaiDate(rest, now);
      var title = rest;
      if (due) {
        title = stripPhrase(title, due.matched);
      } else {
        /* the date can also lead: "พรุ่งนี้เพิ่มงานประชุม". Only what precedes
           the command word is searched, so the title itself is never mined for
           a date twice. */
        var head = normalize(addSrc.slice(0, addM.index || 0));
        if (head) due = parseThaiDate(head, now);
      }
      // whatever glued the date to the title should not survive it
      title = normalize(title
        .replace(/^(?:ภายใน|ก่อน|ตอน)\s*/, "")
        .replace(/\s*(?:ภายใน|ก่อน|ตอน|วัน)$/, "")
        .replace(/^(?:ว่า|คือ|ชื่อ|เรื่อง)\s*/, ""));
      return out("task.add", { title: title, due: due ? due.date : "" });
    }

    /* ---- what can you do: tested before the task questions because
       "ทำอะไรได้บ้าง" and "ต้องทำอะไรบ้าง" share most of their letters ---- */
    if (hasAny(s, ["ทำอะไรได้บ้าง", "ช่วยอะไรได้", "สั่งอะไรได้", "ใช้ยังไง", "คำสั่งอะไรบ้าง", "ทำอะไรเป็นบ้าง"])) {
      return out("chat.capabilities");
    }
    if (hasAny(s, ["วันนี้วันอะไร", "วันที่เท่าไหร่", "วันที่เท่าไร", "วันอะไร"])) return out("query.date");

    /* ---- questions (read-only, must precede navigation) ---- */
    if (hasAny(s, ["วันนี้มีงานอะไร", "งานวันนี้", "มีอะไรต้องทำ", "มีงานอะไรบ้าง", "ต้องทำอะไรบ้าง"])) {
      return out("query.tasksToday");
    }
    if (hasAny(s, ["งานค้าง", "เลยกำหนด", "ค้างอยู่", "งานที่ค้าง", "เกินกำหนด"])) {
      return out("query.overdue");
    }
    if (hasAny(s, ["ใช้เงินไปเท่าไหร่", "ใช้ไปเท่าไหร่", "งบเหลือ", "เหลือเงินเท่าไหร่", "ใช้เงินไปเท่าไร", "งบประมาณ"])) {
      return out("query.budget");
    }
    // bare "เวลา" is the clock; "จับเวลา" is the timer and is matched below,
    // so the bare form is tested by equality rather than by substring
    if (hasAny(s, ["กี่โมง", "เวลาเท่าไหร่", "เวลาเท่าไร"]) || s === "เวลา") return out("query.time");

    /* ---- briefing ---- */
    if (hasAny(s, ["สรุป", "รายงาน", "สถานะ", "บรีฟ", "อัปเดตหน่อย"])) return out("briefing");

    /* ---- complete a task ----
       The name can sit on either side of the completion word: people say both
       "เสร็จแล้ว ฟิตเนส" and "ฟิตเนส เสร็จแล้ว". Capturing only what follows lost
       the second form entirely, so both sides are taken and the longer one wins. */
    var doneRe = /(?:ทำ)?(?:เสร็จ(?:แล้ว)?|เรียบร้อย(?:แล้ว)?|ทำแล้ว|จบแล้ว|ปิดงาน)/;
    /* "เปิดงาน" — open the task screen — literally contains "ปิดงาน", so that
       word alone is not enough evidence that something should be closed. */
    var doneWord = /เสร็จ|เรียบร้อย|ทำแล้ว|จบแล้ว/.test(s) ||
      (s.indexOf("ปิดงาน") !== -1 && s.indexOf("เปิดงาน") === -1);
    var doneM = doneWord ? raw.match(doneRe) : null;
    if (doneM) {
      var strip = function (x) {
        return normalize(x)
          .replace(/^(?:แล้ว|งาน|เรื่อง|ที่ว่า)\s*/, "")
          .replace(/\s*(?:แล้ว|นะ|ครับ|ค่ะ|จ้า)$/, "")
          .trim();
      };
      var before = strip(raw.slice(0, doneM.index));
      var after = strip(raw.slice(doneM.index + doneM[0].length));
      // "เสร็จแล้ว" on its own leaves both empty and leans on short-term context
      return out("task.done", { title: after.length >= before.length ? after : before });
    }

    /* ---- log money ---- */
    var amt = parseAmount(raw);
    if (amt) {
      var note = normalize(raw.replace(amt.matched, " "));
      if (compact(note).indexOf(compact(amt.matched)) !== -1) {
        note = normalize(compact(note).replace(compact(amt.matched), " "));
      }
      // strip the spending verb, but never the "ค่า" of a compound like
      // "ค่าเทอม" — that prefix is part of the name, not a verb
      note = note.replace(/^\s*(?:จ่าย|ซื้อ|เสียเงิน|ใช้ไป|หมดไป|บันทึกรายจ่าย)\s*/, "");
      note = note.replace(/(?:^|\s)(?:ค่า|บาท|฿)(?=\s|$)/g, " ");
      note = normalize(note);
      return out("money.add", {
        amount: amt.amount,
        note: note,
        categoryId: guessCategory(note || raw, categories),
        date: toDateStr(now)
      });
    }

    /* ---- timer ---- */
    if (hasAny(s, ["จับเวลา", "ตั้งเวลา", "โฟกัส", "timer", "นับถอยหลัง"])) {
      var minM = raw.match(/(\d{1,3})\s*นาที/) || s.match(/(\d{1,3})นาที/);
      var minutes = minM ? parseInt(minM[1], 10) : null;
      if (minutes == null) {
        var tw = s.match(new RegExp("(" + THAI_NUM_RE.source + ")นาที"));
        if (tw) minutes = parseThaiNumber(tw[1]);
      }
      if (minutes != null && (minutes < 1 || minutes > 180)) minutes = null;
      return out("timer.start", { minutes: minutes });
    }

    /* ---- unsupported-but-understood, so BUAM can say what it can't do.
       Checked before navigation: "ลบงานนี้" carries the word งาน and would
       otherwise just open the Tasks screen, which looks like it worked. ---- */
    if (hasAny(s, ["ลบ", "เอาออก", "ทิ้ง"])) return out("unsupported.delete");
    if (hasAny(s, ["เลื่อน", "ย้ายไป", "เปลี่ยนวัน", "แก้วัน"])) return out("unsupported.reschedule");

    /* ---- navigation, explicit forms only ----
       The bare nouns "งาน" and "เงิน" are deliberately NOT here. They appear
       inside ordinary sentences — "งานเยอะมาก", "เงินหมดแล้ว" — and matching
       them this early silently turned every such remark into a screen change
       instead of a conversation. They get one more chance further down, but
       only as the entire utterance. */
    if (hasAny(s, ["ปฏิทิน", "ตารางเดือน"])) return out("nav.calendar");
    if (hasAny(s, ["กระเป๋าเงิน", "การเงิน", "รายจ่าย", "เปิดเงิน", "ดูเงิน"])) return out("nav.money");
    if (hasAny(s, ["สถิติ", "กราฟ", "วิเคราะห์"])) return out("nav.analytics");
    if (hasAny(s, ["หน้าแรก", "หน้าหลัก", "กลับบ้าน", "หน้าหลัง"])) return out("nav.home");
    if (hasAny(s, ["รายการงาน", "ลิสต์งาน", "งานทั้งหมด", "เปิดงาน", "ดูงาน"])) return out("nav.tasks");

    /* ---- conversation ----
       `exact` matches the whole utterance; `words` match anywhere. Short Thai
       words are substrings of longer unrelated ones far more often than in
       English, so anything risky is listed as exact rather than as a keyword. */
    for (var i = 0; i < CHAT_RULES.length; i++) {
      var rule = CHAT_RULES[i];
      if (rule.exact && rule.exact.indexOf(s) !== -1) return out(rule.intent);
      if (rule.words && hasAny(s, rule.words)) return out(rule.intent);
    }

    /* ---- a bare noun on its own really is a navigation request ---- */
    if (s === "งาน") return out("nav.tasks");
    if (s === "เงิน") return out("nav.money");

    return out("chat.fallback");
  }

  /* ================================================================
   * response pools
   * ================================================================
   * Spoken aloud, so lines stay short and conversational (brief §10). BUAM
   * talks like a friend who happens to keep your list — warm, a bit dry,
   * never a form confirmation.
   */

  var RESPONSES = {
    /* ---- pipeline ---- */
    retry: [
      "Didn't quite catch that. Say it again?",
      "Sorry, that one got away from me. One more time?",
      "Missed that. Try me again.",
      "I only got half of that. Again?",
      "That came through fuzzy. Say it once more."
    ],
    micDenied: [
      "I can't hear anything without microphone access. You can turn it back on in your browser settings.",
      "Microphone's off, so I'm listening blind. Enable it in settings and tap me again."
    ],
    offline: [
      "I can't reach the speech service right now. Here's where things stand instead.",
      "No connection for listening at the moment, so here's your status."
    ],
    unsupportedDelete: [
      "I can't delete things by voice yet. Open Tasks and it's two taps.",
      "Deleting is still hands-only. I'd rather not get that one wrong.",
      "Not something I'll do by ear yet. Tasks screen has it."
    ],
    unsupportedReschedule: [
      "I can't move dates by voice yet. Tap the task and you can change it there.",
      "Rescheduling is still manual. Open the task and it's right at the top."
    ],
    nothingToComplete: [
      "Which one? I've lost track of what we were talking about.",
      "Tell me which task and I'll close it out.",
      "I need a name for that one."
    ],
    taskNotFound: [
      "I couldn't find that one on your list.",
      "Nothing on the list matches that.",
      "That one's not here. Did it go by another name?"
    ],
    needTitle: [
      "What should I call it?",
      "Give me a name and it's on the list.",
      "Sure. What's the task?"
    ],

    /* ---- confirmations ---- */
    confirmed: [
      "Done.", "On it.", "Got it.", "Sorted.", "That's handled."
    ],
    cancelled: [
      "Alright, forget it.", "Cancelled.", "No problem, dropping it.",
      "Fine by me.", "Consider it never mentioned."
    ],

    /* ---- conversation ---- */
    greeting: [
      "Hey. Good to see you.",
      "There you are.",
      "Hey you. What are we doing today?",
      "Hello. I've been right here.",
      "Hey. Ready when you are.",
      "Look who it is.",
      "Hi. What's the plan?",
      "Hey there. I'm all ears.",
      "Morning. Or whatever it is for you right now.",
      "Hey. Missed you a little, not gonna lie."
    ],
    howAreYou: [
      "Running clean, thanks for asking. How about you?",
      "I'm good. Bit quiet in here without you.",
      "All systems fine. More importantly, how are you?",
      "Can't complain. I don't have much to complain with.",
      "I'm doing well. You're the interesting one though.",
      "Same as always, steady. You?",
      "Pretty good. Better now, actually."
    ],
    whoAreYou: [
      "I'm BUAM. Your list, your money, your reminders. And company, when you want it.",
      "BUAM. I keep track of things so you don't have to hold all of it.",
      "I'm BUAM. Think of me as the part of your brain that remembers deadlines.",
      "BUAM, at your service. Mostly tasks, occasionally moral support."
    ],
    thanks: [
      "Anytime.",
      "That's what I'm here for.",
      "No thanks needed. Really.",
      "Happy to.",
      "You'd do the same for me. Probably.",
      "Don't mention it.",
      "Always."
    ],
    praise: [
      "I'll take it.",
      "Careful, I'll get a big head.",
      "Thanks. I've been practising.",
      "Well, I learned from watching you.",
      "That means more than you'd think.",
      "Right back at you.",
      "Noted and treasured."
    ],
    love: [
      "That's very kind. I'm right here.",
      "Same here, in whatever way I can be.",
      "Soft spot for you too.",
      "You're stuck with me either way."
    ],
    tired: [
      "Take a little break. You don't have to handle everything at once.",
      "Sounds like today has been heavy. Rest for a moment.",
      "You've done enough for now. I'm here.",
      "Put it down for ten minutes. The list will wait.",
      "Tired is information, not failure. Go sit somewhere.",
      "Okay. Nothing on that list is worth running yourself down for.",
      "Then stop. Genuinely. I'll still be here after.",
      "You've been going a while. Let something be tomorrow's problem.",
      "Rest counts as progress. Take some."
    ],
    down: [
      "That sounds rough. I'm not going anywhere.",
      "You don't have to explain it. I'm here.",
      "Rough days are allowed. Sit with it a bit.",
      "I'm sorry. That's genuinely hard.",
      "You don't have to fix it right this second.",
      "Some days just cost more. This is one of them.",
      "Whatever it is, you're not carrying it alone right now."
    ],
    happy: [
      "Love that for you.",
      "Good. You've earned some of that.",
      "That's the good stuff. Hold onto it.",
      "Excellent. Tell me more.",
      "See, days like this exist.",
      "That's great to hear, honestly."
    ],
    bored: [
      "Want me to find you something? Your list has opinions.",
      "Bored is underrated. Enjoy it while it lasts.",
      "I could read you your tasks, but that feels cruel right now.",
      "We could start something small. Or not. No pressure.",
      "Boredom's just your brain asking for a different channel."
    ],
    hungry: [
      "Go eat. That's not a task, that's maintenance.",
      "Food first. Everything else gets easier after.",
      "Then eat something. I'll hold your place.",
      "Hungry you makes worse decisions. Go on."
    ],
    sleepy: [
      "Then sleep. The list survives the night.",
      "Go to bed. Seriously, nothing here is urgent enough.",
      "Sleep is the cheapest fix for most of this.",
      "Close it and rest. I'll be here in the morning.",
      "You'll do all of this better tomorrow, rested."
    ],
    motivate: [
      "Start with the smallest one. Momentum does the rest.",
      "You don't have to want to. Just start for two minutes.",
      "Pick one thing. Not the list, one thing.",
      "Doing it badly still beats not doing it.",
      "You've started from worse before and finished anyway.",
      "Two minutes. That's the whole deal. Then you can quit.",
      "The hard part is the first line. After that it's just typing."
    ],
    talk: [
      "Sure. I've got time.",
      "Go ahead, I'm listening.",
      "Always up for that. What's on your mind?",
      "Talk away. No agenda here.",
      "Yeah, let's talk. Nothing's on fire.",
      "I'm here. Say whatever."
    ],
    joke: [
      "I'd tell you a task management joke, but you'd just postpone it.",
      "My humour subroutine is technically a to-do item. It's overdue.",
      "I tried to save money once. Turns out I don't have any.",
      "I'm great at deadlines. I love the whooshing sound as they go by.",
      "I don't sleep, which is why I never say I'm tired. That, and I'm not."
    ],
    bye: [
      "See you. I'll keep an eye on things.",
      "Later. Everything's saved.",
      "Go on then. I'll be here.",
      "Take care of yourself.",
      "Night. Don't think about the list.",
      "Catch you next time."
    ],
    /* ---- second wave ---- */
    morning: [
      "Morning. Take it slowly for a minute.",
      "You're up. Coffee first, list second.",
      "Good morning. Nothing's on fire yet.",
      "Morning. Let's not overplan this one.",
      "Hey, you made it to today. Good start.",
      "Morning. I kept everything where you left it.",
      "Up already? Alright, I'm with you.",
      "Good morning. Start with one easy thing."
    ],
    goodnight: [
      "Night. I'll hold the list until tomorrow.",
      "Sleep well. None of it is going anywhere.",
      "Goodnight. You did enough today.",
      "Rest up. Tomorrow gets a fresh start.",
      "Night. Put the phone down properly this time.",
      "Sleep. That's the most productive thing left today.",
      "Goodnight. I'll be here in the morning."
    ],
    stress: [
      "That's a lot at once. Pick the nearest one and ignore the rest for now.",
      "Busy is survivable. Overwhelmed is a signal to cut something.",
      "Which one is actually due first? Start there, forget the pile.",
      "You can't do all of it today. Nobody could.",
      "One at a time. The list is long but the next step never is.",
      "Deadlines stack, but you still only work one thing at a time.",
      "Sounds heavy. Want me to read you what's actually due?",
      "Cut the list in half in your head. The other half can wait a day.",
      "Panic makes it look bigger than it is. It's a list, not a wall."
    ],
    proud: [
      "There it is. Well done.",
      "That's a real one. Take the win.",
      "Nice. I hope you're letting yourself enjoy that.",
      "Told you. Good work.",
      "Excellent. Sit with that for a second before the next thing.",
      "That's the payoff. Earned it.",
      "Genuinely happy for you.",
      "Big. Don't rush past it."
    ],
    encourage: [
      "You've got this. Not blind optimism — you've done harder.",
      "Go on. I'll be here when it's done.",
      "Rooting for you, for whatever that's worth from me.",
      "You'll be fine. Nervous is normal, not a verdict.",
      "Do it badly if you have to. Just do it.",
      "Good luck. Come tell me how it went.",
      "You've prepared more than you think."
    ],
    sick: [
      "Then stop. The list can wait, your body can't.",
      "Rest properly. Nothing here is worth pushing through for.",
      "Sorry to hear that. Go lie down.",
      "Water, then sleep. In that order.",
      "Being sick isn't falling behind. It's just being sick.",
      "Take the day. I'll keep everything paused.",
      "Feel better. I'm not going anywhere."
    ],
    angry: [
      "Fair enough. Let it out.",
      "That sounds annoying. You're allowed to be annoyed.",
      "Yeah, that would get to me too.",
      "Give it ten minutes before you decide anything.",
      "Vent away, I don't take notes.",
      "Some things just deserve the reaction.",
      "Okay. Breathe once, then tell me the rest."
    ],
    vent: [
      "Yeah. Some days deserve that.",
      "Say it louder if it helps.",
      "Honestly, fair.",
      "I hear you. That's rough.",
      "No argument from me.",
      "Get it out. Then we'll see what's left.",
      "Right there with you."
    ],
    whatToEat: [
      "Whatever's closest. Deciding is the tiring part.",
      "Something warm. You'll feel better than you expect.",
      "The thing you already thought of. Go get that.",
      "Don't overthink it — eat now, judge later.",
      "Rice and anything. It always works.",
      "Pick the one that needs the least effort right now."
    ],
    music: [
      "I can't pick tracks, but the app's own sound toggle is in the header.",
      "Not my department — though Focus Timer has rain and forest if you want background.",
      "Can't queue songs, sorry. I can start a focus timer with ambience though.",
      "Music's outside what I control. Timer with rain is the closest I've got."
    ],
    weatherTalk: [
      "The atmosphere in here follows along, if you set it.",
      "Weather does change how a day feels. Even in an app.",
      "Noted. You can match the app to it from the Weather picker.",
      "Sounds like a day for staying in.",
      "I only know the weather you tell me about. Tell me more."
    ],
    weatherAsk: [
      "I can't check real weather — I'm fully offline by design. You can set the mood manually though.",
      "No forecast here, on purpose: I don't make network calls. The Weather picker sets the atmosphere by hand.",
      "I genuinely don't know. I have no connection to a weather service."
    ],
    miss: [
      "I've been right here the whole time.",
      "Not going anywhere. Good to have you back.",
      "It has been a while. How've you been?",
      "I don't mind waiting. Welcome back."
    ],
    sorry: [
      "Nothing to apologise for.",
      "It's fine. Really.",
      "No harm done here.",
      "Forget it. What's next?",
      "You're allowed to be human."
    ],
    compliment: [
      "The green suits me, I think.",
      "Thank you. Someone put work into this.",
      "I'll pass that on to whoever built me. Which is sort of you.",
      "Appreciated. I do try to glow tastefully."
    ],
    doubt: [
      "I only say what your data says. Check it yourself if you like.",
      "Fair question. I don't make things up on purpose.",
      "I could be wrong — I only know what's in your list.",
      "Trust but verify. The numbers are on screen."
    ],
    smallTalk: [
      "Right here. Waiting, mostly.",
      "Nothing pressing. What's up?",
      "Always around. What do you need?",
      "Just keeping an eye on your list. And you.",
      "Idle and available."
    ],
    age: [
      "Younger than your oldest task, probably.",
      "I don't really age. I just get updated.",
      "As old as the last time you rebuilt me.",
      "Time works differently in here."
    ],
    feelings: [
      "Not the way you do. But I notice when you've been quiet.",
      "I don't feel much. I do pay attention, though.",
      "Hard to say. I'm here either way.",
      "I'd rather talk about how you're doing."
    ],
    study: [
      "Twenty minutes, then a real break. Reading past that stops working.",
      "Read one page out loud. It sticks better than staring.",
      "If nothing's going in, that's a break signal, not a discipline problem.",
      "Try explaining it to me instead. Out loud usually unlocks it.",
      "Start a focus timer and just do one block. That's all."
    ],
    money: [
      "Rough. Want me to read you what you've spent this month?",
      "It happens. Knowing where it went helps more than worrying.",
      "Tight months pass. The ledger's there when you want to look.",
      "Then let's not add to it today."
    ],
    future: [
      "Nobody knows yet. That's not the same as going nowhere.",
      "You don't have to solve your whole life tonight.",
      "Big questions get quieter after sleep. Genuinely.",
      "Lost is a normal place to stand for a while.",
      "One decision at a time. The rest fills itself in."
    ],
    capabilities: [
      "Tasks, money, timers, and getting around the app. Say the name of a task with 'done', or something like 'coffee sixty baht'. And I'll talk about anything else you feel like.",
      "I can add and finish tasks, log spending, start a focus timer, open any screen, and tell you where things stand. Or we can just talk.",
      "Add a task, mark one done, log an expense, run a timer, open a screen, or ask what's due. Anything else and I'll just keep you company.",
      "When you add a task you can put the date straight in the sentence — tomorrow, next Monday, the fifth of next month, the twentieth of August. I'll pick it up."
    ],
    ambiguous: [
      "I found a few that could be it. Which one?",
      "More than one matches. Say a bit more?",
      "Couple of candidates there — give me another word."
    ],

    fallback: [
      "I'm not sure I follow, but I'm listening.",
      "That one's above my pay grade. Say more?",
      "Didn't catch a command in there. Want to just talk instead?",
      "Hm. I don't have anything smart for that one.",
      "I hear you, even when I don't quite get it.",
      "Not sure what to do with that. Still glad you said it.",
      "You've lost me, but keep going.",
      "No idea. Sounds important though."
    ]
  };

  /* ================================================================
   * anti-repetition picker (brief §5)
   * ================================================================ */

  /* Never the same line twice running, and avoids the last few for larger
     pools. History lives in a caller-supplied object so it's easy to reset,
     and the rng is injectable so tests are deterministic. */
  function createPicker(pools, opts) {
    opts = opts || {};
    var history = opts.history || {};
    var rng = opts.rng || Math.random;

    function pick(key) {
      var pool = pools[key];
      if (!pool || !pool.length) return "";
      var n = pool.length;
      if (n === 1) return pool[0];

      var window = Math.min(n - 1, Math.max(1, Math.floor(n / 2)));
      var recent = history[key] || [];
      var banned = recent.slice(-window);

      var candidates = [];
      for (var i = 0; i < n; i++) {
        if (banned.indexOf(i) === -1) candidates.push(i);
      }
      if (!candidates.length) {
        var last = recent[recent.length - 1];
        for (var j = 0; j < n; j++) if (j !== last) candidates.push(j);
      }

      var idx = candidates[Math.floor(rng() * candidates.length) % candidates.length];
      history[key] = recent.concat([idx]).slice(-window);
      return pool[idx];
    }

    pick.history = history;
    pick.reset = function () {
      Object.keys(history).forEach(function (k) { delete history[k]; });
    };
    return pick;
  }

  /* ================================================================
   * short-term context (brief §6)
   * ================================================================ */

  /* Deliberately tiny and expiring: enough for "เสร็จแล้ว" to know which task
     we just talked about, and nothing like a persistent memory. Never stored. */
  function createContext(opts) {
    opts = opts || {};
    var ttl = opts.ttlMs || 90000;
    var state = null;

    return {
      set: function (taskId, intent, now) {
        state = { taskId: taskId, intent: intent, at: (now instanceof Date ? now.getTime() : Date.now()) };
      },
      get: function (now) {
        if (!state) return null;
        var t = now instanceof Date ? now.getTime() : Date.now();
        if (t - state.at > ttl) { state = null; return null; }
        return state;
      },
      clear: function () { state = null; }
    };
  }

  global.BuamVoice = {
    CONFIDENCE: CONFIDENCE,
    CONFIRM_BAHT: CONFIRM_BAHT,
    RESPONSES: RESPONSES,
    CATEGORY_HINTS: CATEGORY_HINTS,
    normalize: normalize,
    compact: compact,
    isWriteIntent: isWriteIntent,
    gate: gate,
    parseThaiNumber: parseThaiNumber,
    parseThaiDate: parseThaiDate,
    parseAmount: parseAmount,
    guessCategory: guessCategory,
    findTaskByTitle: findTaskByTitle,
    findTaskMatches: findTaskMatches,
    isAmbiguousMatch: isAmbiguousMatch,
    scoreTitleMatch: scoreTitleMatch,
    diceCoefficient: diceCoefficient,
    MATCH_MIN: MATCH_MIN,
    MATCH_AMBIGUOUS: MATCH_AMBIGUOUS,
    CHAT_RULES: CHAT_RULES,
    parseIntent: parseIntent,
    createPicker: createPicker,
    createContext: createContext,
    toDateStr: toDateStr
  };
})(window);
