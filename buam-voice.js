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

  /* Finds a date expression anywhere in the text.
     Returns { date: "YYYY-MM-DD", matched: "<the phrase>" } or null, so the
     caller can strip the phrase out of a task title. */
  function parseThaiDate(text, now) {
    var raw = normalize(text);
    var s = compact(raw);
    if (!s) return null;
    var base = now instanceof Date ? now : new Date();

    function found(d, phrase) { return { date: toDateStr(d), matched: phrase }; }

    // relative days — check the longer phrases first
    if (s.indexOf("มะรืน") !== -1) return found(addDays(base, 2), "มะรืนนี้");
    if (s.indexOf("พรุ่งนี้") !== -1) return found(addDays(base, 1), "พรุ่งนี้");
    if (s.indexOf("เมื่อวาน") !== -1) return found(addDays(base, -1), "เมื่อวาน");
    if (s.indexOf("วันนี้") !== -1) return found(base, "วันนี้");

    if (hasAny(s, ["อาทิตย์หน้า", "สัปดาห์หน้า", "อาทิตย์ถัดไป"])) {
      return found(addDays(base, 7), "สัปดาห์หน้า");
    }
    if (s.indexOf("สิ้นเดือน") !== -1) {
      return found(new Date(base.getFullYear(), base.getMonth() + 1, 0), "สิ้นเดือน");
    }
    if (s.indexOf("เดือนหน้า") !== -1) {
      var nm = new Date(base.getFullYear(), base.getMonth() + 1, base.getDate());
      return found(nm, "เดือนหน้า");
    }

    // named weekday -> the next time that day comes round (never today)
    for (var i = 0; i < WEEKDAYS.length; i++) {
      var w = WEEKDAYS[i];
      for (var j = 0; j < w.names.length; j++) {
        if (s.indexOf(w.names[j]) !== -1) {
          var delta = (w.dow - base.getDay() + 7) % 7;
          if (delta === 0) delta = 7;
          return found(addDays(base, delta), w.names[j]);
        }
      }
    }

    // "วันที่ 20" -> the 20th of this month, or next month if already past
    var m = raw.match(/วันที่\s*(\d{1,2})/) || s.match(/วันที่(\d{1,2})/);
    if (m) {
      var day = parseInt(m[1], 10);
      if (day >= 1 && day <= 31) {
        var target = new Date(base.getFullYear(), base.getMonth(), day);
        if (target.getDate() !== day || target < new Date(base.getFullYear(), base.getMonth(), base.getDate())) {
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

  /* Loose title match for "เสร็จแล้ว <title>". Prefers unfinished tasks and
     the longest overlap, so a short spoken fragment still finds its task. */
  function findTaskByTitle(title, tasks) {
    var q = compact(title).toLowerCase();
    if (!q || !tasks || !tasks.length) return null;
    var best = null, bestLen = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var tt = compact(t.title).toLowerCase();
      if (!tt) continue;
      var overlap = 0;
      if (tt.indexOf(q) !== -1) overlap = q.length;
      else if (q.indexOf(tt) !== -1) overlap = tt.length;
      if (!overlap) continue;
      // an unfinished task always beats a finished one of the same overlap
      var weight = overlap + (t.done ? 0 : 0.5);
      if (weight > bestLen) { bestLen = weight; best = t; }
    }
    return best;
  }

  /* ================================================================
   * intent router
   * ================================================================ */

  var CHAT_RULES = [
    { intent: "chat.whoAreYou", words: ["เป็นใคร", "คือใคร", "ชื่ออะไร", "แนะนำตัว"] },
    { intent: "chat.howAreYou", words: ["เป็นไงบ้าง", "เป็นยังไงบ้าง", "สบายดีไหม", "สบายดีมั้ย", "เป็นไง"] },
    { intent: "chat.thanks", words: ["ขอบคุณ", "ขอบใจ", "แต๊งกิ้ว"] },
    { intent: "chat.praise", words: ["เก่ง", "เยี่ยม", "สุดยอด", "ดีมาก", "เจ๋ง", "แจ่ม", "โคตรดี"] },
    { intent: "chat.love", words: ["รักนาย", "รักเธอ", "คิดถึง", "รักเลย"] },
    { intent: "chat.joke", words: ["เล่าเรื่องตลก", "มุกตลก", "เล่ามุก", "ขำ", "เล่าอะไรหน่อย"] },
    { intent: "chat.bye", words: ["บาย", "ไปก่อน", "ลาก่อน", "ไว้เจอกัน", "ฝันดี", "ราตรีสวัสดิ์"] },
    { intent: "chat.tired", words: ["เหนื่อย", "ล้า", "เพลีย", "หมดแรง", "หมดพลัง", "ไม่ไหวแล้ว"] },
    { intent: "chat.down", words: ["เศร้า", "เสียใจ", "ท้อ", "แย่จัง", "ไม่โอเค", "ร้องไห้", "เครียด"] },
    { intent: "chat.happy", words: ["ดีใจ", "มีความสุข", "สนุก", "ฟินมาก", "แฮปปี้"] },
    { intent: "chat.bored", words: ["เบื่อ", "ไม่มีอะไรทำ", "ว่างจัง"] },
    { intent: "chat.hungry", words: ["หิว", "อยากกิน", "ท้องร้อง"] },
    { intent: "chat.sleepy", words: ["ง่วง", "อยากนอน", "นอนไม่หลับ", "ไม่ได้นอน"] },
    { intent: "chat.motivate", words: ["ไม่อยากทำ", "ขี้เกียจ", "ทำไม่ไหว", "ให้กำลังใจ", "ผัดวันประกันพรุ่ง"] },
    { intent: "chat.talk", words: ["คุยกัน", "คุยด้วย", "อยากคุย", "เหงา", "อยู่เป็นเพื่อน"] },
    { intent: "chat.greeting", words: ["สวัสดี", "หวัดดี", "ดีจ้า", "ว่าไง", "เฮ้", "ฮัลโหล"] }
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

    /* ---- add a task ---- */
    var addM = raw.match(/(?:เพิ่ม|สร้าง|จด|ใส่|บันทึก)\s*(?:งาน|ทาสก์|ทาส์ก|task)\s*(.*)$/i);
    if (!addM) {
      var addC = s.match(/(?:เพิ่ม|สร้าง|จด|ใส่|บันทึก)(?:งาน|ทาสก์|ทาส์ก|task)(.*)$/i);
      if (addC) addM = addC;
    }
    if (addM) {
      var rest = normalize(addM[1] || "");
      var due = parseThaiDate(rest, now);
      var title = rest;
      if (due) {
        title = normalize(
          title.replace(due.matched, " ")
               .replace(/(?:ภายใน|ก่อน|ตอน|วัน)?\s*$/,"")
        );
        // the phrase may have been joined to the title with no space
        if (compact(title).indexOf(compact(due.matched)) !== -1) {
          title = normalize(compact(title).replace(compact(due.matched), " "));
        }
      }
      title = title.replace(/^(?:ว่า|คือ|ชื่อ|เรื่อง)\s*/, "").trim();
      return out("task.add", { title: title, due: due ? due.date : "" });
    }

    /* ---- complete a task ---- */
    var doneM = raw.match(/(?:ทำ)?(?:เสร็จ(?:แล้ว)?|เรียบร้อย(?:แล้ว)?|ทำแล้ว|จบแล้ว|ปิดงาน)\s*(.*)$/);
    if (doneM && /เสร็จ|เรียบร้อย|ทำแล้ว|จบแล้ว|ปิดงาน/.test(s)) {
      var doneTitle = normalize(doneM[1] || "").replace(/^(?:แล้ว|งาน|เรื่อง)\s*/, "").trim();
      // "เสร็จแล้ว" on its own leans on short-term context instead
      return out("task.done", { title: doneTitle });
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

    /* ---- navigation ---- */
    if (hasAny(s, ["ปฏิทิน", "ตารางเดือน"])) return out("nav.calendar");
    if (hasAny(s, ["กระเป๋าเงิน", "การเงิน", "รายจ่าย", "เงิน"])) return out("nav.money");
    if (hasAny(s, ["สถิติ", "กราฟ", "วิเคราะห์"])) return out("nav.analytics");
    if (hasAny(s, ["หน้าแรก", "หน้าหลัก", "กลับบ้าน", "หน้าหลัง"])) return out("nav.home");
    if (hasAny(s, ["รายการงาน", "ลิสต์งาน", "งานทั้งหมด", "งาน"])) return out("nav.tasks");

    /* ---- conversation ---- */
    for (var i = 0; i < CHAT_RULES.length; i++) {
      if (hasAny(s, CHAT_RULES[i].words)) return out(CHAT_RULES[i].intent);
    }

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
    parseIntent: parseIntent,
    createPicker: createPicker,
    createContext: createContext,
    toDateStr: toDateStr
  };
})(window);
