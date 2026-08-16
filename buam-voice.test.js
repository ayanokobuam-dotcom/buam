/* buam-voice.test.js — dependency-free tests for the voice engine's logic.
   Same shape as buam-money.test.js: no assertion library, runs in the browser
   via buam-voice.test.html (which loads buam-voice.js first).

   The intent cases are not invented — they are the phrases the target device
   actually transcribed during the mic-test rounds, plus the variants those
   results imply. */
(function () {
  "use strict";

  var V = window.BuamVoice;

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
  function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg || "expected truthy value");
  }
  function assertNull(v, msg) {
    if (v !== null) throw new Error((msg ? msg + " — " : "") + "expected null but got " + JSON.stringify(v));
  }

  // a fixed Saturday so weekday maths is checkable by hand
  var NOW = new Date(2026, 7, 15, 10, 0, 0); // 2026-08-15, a Saturday
  function cats() {
    return {
      expense: [
        { id: "exp-food", name: "อาหาร", archived: false },
        { id: "exp-transport", name: "เดินทาง", archived: false },
        { id: "exp-study", name: "การเรียน", archived: false },
        { id: "exp-fun", name: "ความบันเทิง", archived: false },
        { id: "exp-other", name: "อื่น ๆ", archived: false }
      ]
    };
  }

  /* ================= normalization ================= */

  test("compact strips the spacing that Thai recognition inserts unpredictably", function () {
    assertEqual(V.compact("เปิด ปฏิทิน"), "เปิดปฏิทิน");
    assertEqual(V.compact("  กาแฟ   60  บาท "), "กาแฟ60บาท");
    assertEqual(V.compact(""), "");
    assertEqual(V.compact(null), "");
  });

  /* ================= intents from real transcripts ================= */

  test("every command the device actually transcribed routes correctly", function () {
    var cases = [
      // [transcript, expected intent]  — all observed at 0.94-1.00 on device
      ["สวัสดี", "chat.greeting"],
      ["เวลา", "query.time"],
      ["เงิน", "nav.money"],
      ["ปฏิทิน", "nav.calendar"],
      ["เปิดปฏิทิน", "nav.calendar"],
      ["จับเวลา", "timer.start"],
      ["เพิ่มงาน", "task.add"],
      ["กาแฟ 60 บาท", "money.add"],
      ["เยี่ยม", "chat.praise"],
      ["สรุป", "briefing"]
    ];
    cases.forEach(function (c) {
      var got = V.parseIntent(c[0], { now: NOW, categories: cats() });
      assertEqual(got.intent, c[1], 'transcript "' + c[0] + '"');
    });
  });

  test("casual and off-script speech never reaches a write intent", function () {
    // the device transcribed these at 0.99 during testing
    var casual = [
      "ผมชื่อปอนด์",
      "กูเป็นเกย์",
      "มึงนี่มันเก่งจริงๆเลยว่ะ",
      "เป็น",
      "ตื่น",
      "วันนี้อากาศดีจัง",
      "ไม่รู้จะพูดอะไรดี"
    ];
    casual.forEach(function (t) {
      var got = V.parseIntent(t, { now: NOW, categories: cats() });
      assertTrue(!V.isWriteIntent(got.intent),
        '"' + t + '" must not be a write intent, got ' + got.intent);
    });
  });

  test("questions beat navigation for the same keyword", function () {
    assertEqual(V.parseIntent("ใช้เงินไปเท่าไหร่แล้ว", { now: NOW }).intent, "query.budget");
    assertEqual(V.parseIntent("วันนี้มีงานอะไรบ้าง", { now: NOW }).intent, "query.tasksToday");
    assertEqual(V.parseIntent("งานค้างมีอะไรบ้าง", { now: NOW }).intent, "query.overdue");
    // and the bare keywords still navigate
    assertEqual(V.parseIntent("เงิน", { now: NOW }).intent, "nav.money");
    assertEqual(V.parseIntent("รายการงาน", { now: NOW }).intent, "nav.tasks");
  });

  test("understood-but-unsupported commands are reported, not silently dropped", function () {
    assertEqual(V.parseIntent("ลบงานนี้", { now: NOW }).intent, "unsupported.delete");
    assertEqual(V.parseIntent("เลื่อนเป็นพรุ่งนี้", { now: NOW }).intent, "unsupported.reschedule");
  });

  /* ================= task.add ================= */

  test("task.add extracts the title and strips the date phrase out of it", function () {
    var r = V.parseIntent("เพิ่มงาน ส่งการบ้านเลข พรุ่งนี้", { now: NOW });
    assertEqual(r.intent, "task.add");
    assertEqual(r.params.due, "2026-08-16");
    assertEqual(V.compact(r.params.title), "ส่งการบ้านเลข");
  });

  test("task.add works with no date and with no spaces", function () {
    var a = V.parseIntent("เพิ่มงานซื้อนม", { now: NOW });
    assertEqual(a.intent, "task.add");
    assertEqual(V.compact(a.params.title), "ซื้อนม");
    assertEqual(a.params.due, "");

    var b = V.parseIntent("เพิ่มงาน", { now: NOW });
    assertEqual(b.intent, "task.add");
    assertEqual(b.params.title, "", "a bare command has no title to add");
  });

  test("task.add accepts the other verbs people actually use", function () {
    ["สร้างงานอ่านหนังสือ", "จดงานอ่านหนังสือ", "บันทึกงานอ่านหนังสือ"].forEach(function (t) {
      var r = V.parseIntent(t, { now: NOW });
      assertEqual(r.intent, "task.add", t);
      assertEqual(V.compact(r.params.title), "อ่านหนังสือ", t);
    });
  });

  /* ================= dates ================= */

  test("relative dates resolve against the supplied now", function () {
    assertEqual(V.parseThaiDate("วันนี้", NOW).date, "2026-08-15");
    assertEqual(V.parseThaiDate("พรุ่งนี้", NOW).date, "2026-08-16");
    assertEqual(V.parseThaiDate("มะรืนนี้", NOW).date, "2026-08-17");
    assertEqual(V.parseThaiDate("สัปดาห์หน้า", NOW).date, "2026-08-22");
    assertEqual(V.parseThaiDate("สิ้นเดือน", NOW).date, "2026-08-31");
    assertNull(V.parseThaiDate("ไม่มีวันที่ตรงนี้", NOW));
  });

  test("named weekdays always land in the future, never today", function () {
    // NOW is a Saturday
    assertEqual(V.parseThaiDate("วันจันทร์", NOW).date, "2026-08-17");
    assertEqual(V.parseThaiDate("วันศุกร์", NOW).date, "2026-08-21");
    assertEqual(V.parseThaiDate("วันเสาร์", NOW).date, "2026-08-22", "same weekday means next week");
  });

  test("dates cross month and year boundaries correctly", function () {
    var endOfMonth = new Date(2026, 7, 31, 9, 0, 0);      // 2026-08-31
    assertEqual(V.parseThaiDate("พรุ่งนี้", endOfMonth).date, "2026-09-01");

    var newYearsEve = new Date(2026, 11, 31, 9, 0, 0);    // 2026-12-31
    assertEqual(V.parseThaiDate("พรุ่งนี้", newYearsEve).date, "2027-01-01");
    assertEqual(V.parseThaiDate("สัปดาห์หน้า", newYearsEve).date, "2027-01-07");

    var feb = new Date(2028, 1, 10, 9, 0, 0);             // 2028 is a leap year
    assertEqual(V.parseThaiDate("สิ้นเดือน", feb).date, "2028-02-29");
  });

  test('"วันที่ N" picks this month, or next month when the day has passed', function () {
    assertEqual(V.parseThaiDate("วันที่ 20", NOW).date, "2026-08-20");
    assertEqual(V.parseThaiDate("วันที่ 3", NOW).date, "2026-09-03", "the 3rd already passed");
  });

  test("parsed dates match the app's own local-date formatting", function () {
    var d = new Date(2026, 0, 5, 23, 30, 0);
    // mirrors localDateStr() in index.html
    var expected = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
    assertEqual(V.toDateStr(d), expected);
    assertEqual(V.parseThaiDate("วันนี้", d).date, expected);
  });

  /* ================= amounts ================= */

  test("digit amounts parse, which is what the device actually produces", function () {
    var a = V.parseAmount("กาแฟ 60 บาท");
    assertEqual(a.amount, 60);
    var b = V.parseAmount("ค่าข้าว 120 บาท");
    assertEqual(b.amount, 120);
    var c = V.parseAmount("ค่าเทอม 15,000 บาท");
    assertEqual(c.amount, 15000);
    var d = V.parseAmount("จ่ายค่าไฟ 350.50 บาท");
    assertEqual(d.amount, 350.5);
  });

  test("Thai-word amounts parse as a fallback", function () {
    assertEqual(V.parseThaiNumber("หกสิบ"), 60);
    assertEqual(V.parseThaiNumber("ห้าสิบห้า"), 55);
    assertEqual(V.parseThaiNumber("สิบห้า"), 15);
    assertEqual(V.parseThaiNumber("ยี่สิบเอ็ด"), 21);
    assertEqual(V.parseThaiNumber("สองร้อยห้าสิบ"), 250);
    assertEqual(V.parseThaiNumber("หนึ่งพันห้าร้อย"), 1500);
    assertEqual(V.parseAmount("กาแฟหกสิบบาท").amount, 60);
  });

  test("a number with a non-money unit is never an expense", function () {
    assertNull(V.parseAmount("จับเวลา 25 นาที"), "minutes are not baht");
    var t = V.parseIntent("จับเวลา 25 นาที", { now: NOW, categories: cats() });
    assertEqual(t.intent, "timer.start");
    assertEqual(t.params.minutes, 25);
  });

  test("bare numbers only count as money with a spending verb", function () {
    assertNull(V.parseAmount("50"), "a naked number is not a transaction");
    assertEqual(V.parseAmount("จ่ายค่ารถ 50").amount, 50);
  });

  test("money.add fills amount, note, category and today's date", function () {
    var r = V.parseIntent("กาแฟ 60 บาท", { now: NOW, categories: cats() });
    assertEqual(r.intent, "money.add");
    assertEqual(r.params.amount, 60);
    assertEqual(V.compact(r.params.note), "กาแฟ");
    assertEqual(r.params.categoryId, "exp-food");
    assertEqual(r.params.date, "2026-08-15");
  });

  test("the note keeps compound names but loses the spending verb", function () {
    // "ค่า" here is part of the name (tuition fee), not a verb to strip
    assertEqual(V.compact(V.parseIntent("ค่าเทอม 15000 บาท", { now: NOW, categories: cats() }).params.note), "ค่าเทอม");
    assertEqual(V.compact(V.parseIntent("จ่ายค่ารถ 50", { now: NOW, categories: cats() }).params.note), "ค่ารถ");
    assertEqual(V.compact(V.parseIntent("ซื้อขนม 25 บาท", { now: NOW, categories: cats() }).params.note), "ขนม");
  });

  test("category guessing falls back safely and respects the live list", function () {
    assertEqual(V.guessCategory("แท็กซี่", cats()), "exp-transport");
    assertEqual(V.guessCategory("ดูหนัง", cats()), "exp-fun");
    assertEqual(V.guessCategory("อะไรก็ไม่รู้", cats()), "exp-other", "unknown falls back to the other bucket");
    // a user who deleted every hinted category still gets a valid id
    var trimmed = { expense: [{ id: "custom-1", name: "ของฉัน", archived: false }] };
    assertEqual(V.guessCategory("กาแฟ", trimmed), "custom-1");
    // archived categories are never chosen
    var archived = { expense: [{ id: "exp-food", name: "อาหาร", archived: true }, { id: "keep", name: "ใช้ได้", archived: false }] };
    assertEqual(V.guessCategory("กาแฟ", archived), "keep");
  });

  /* ================= task.done ================= */

  test("task.done carries a title when given one and none when not", function () {
    var withTitle = V.parseIntent("เสร็จแล้ว ซื้อนม", { now: NOW });
    assertEqual(withTitle.intent, "task.done");
    assertEqual(V.compact(withTitle.params.title), "ซื้อนม");

    var bare = V.parseIntent("เสร็จแล้ว", { now: NOW });
    assertEqual(bare.intent, "task.done");
    assertEqual(bare.params.title, "", "a bare completion leans on context instead");
  });

  test("the task name is picked up on either side of the completion word", function () {
    var after = V.parseIntent("เสร็จแล้ว ฟิตเนส", { now: NOW });
    assertEqual(V.compact(after.params.title), "ฟิตเนส");

    var before = V.parseIntent("ฟิตเนส เสร็จแล้ว", { now: NOW });
    assertEqual(before.intent, "task.done");
    assertEqual(V.compact(before.params.title), "ฟิตเนส", "a name spoken first must not be dropped");

    var joined = V.parseIntent("การบ้านเสร็จแล้ว", { now: NOW });
    assertEqual(V.compact(joined.params.title), "การบ้าน");

    var polite = V.parseIntent("ซื้อนม เรียบร้อยแล้ว ครับ", { now: NOW });
    assertEqual(V.compact(polite.params.title), "ซื้อนม", "trailing politeness is not part of the name");
  });

  test("findTaskByTitle prefers unfinished tasks and the longest overlap", function () {
    var tasks = [
      { id: "a", title: "ซื้อนม", done: true },
      { id: "b", title: "ซื้อนมกับขนม", done: false },
      { id: "c", title: "อ่านหนังสือ", done: false }
    ];
    assertEqual(V.findTaskByTitle("ซื้อนมกับขนม", tasks).id, "b");
    assertEqual(V.findTaskByTitle("อ่านหนังสือ", tasks).id, "c");
    assertNull(V.findTaskByTitle("ไม่มีงานนี้", tasks));
    assertNull(V.findTaskByTitle("", tasks));
  });

  /* ================= keyword matching ================= */

  test("a single keyword finds a task without reciting the whole title", function () {
    var tasks = [
      { id: "hw", title: "ส่งการบ้านเลข 5 ข้อ ก่อนเที่ยง", done: false },
      { id: "gym", title: "ไปฟิตเนสตอนเย็น", done: false },
      { id: "buy", title: "ซื้อของเข้าบ้าน", done: false }
    ];
    // the point of the feature: short spoken fragments, not full titles
    assertEqual(V.findTaskByTitle("การบ้าน", tasks).id, "hw");
    assertEqual(V.findTaskByTitle("เลข", tasks).id, "hw");
    assertEqual(V.findTaskByTitle("ฟิตเนส", tasks).id, "gym");
    assertEqual(V.findTaskByTitle("ซื้อของ", tasks).id, "buy");
    assertEqual(V.findTaskByTitle("ส่งการบ้าน", tasks).id, "hw");
  });

  test("near-misses from the recognizer still land on the right task", function () {
    var tasks = [
      { id: "eng", title: "อ่านหนังสือภาษาอังกฤษ", done: false },
      { id: "math", title: "ทบทวนคณิตศาสตร์", done: false }
    ];
    // heard slightly wrong, but the shape is close enough
    assertEqual(V.findTaskByTitle("อ่านหนังสืออังกฤษ", tasks).id, "eng");
    assertEqual(V.findTaskByTitle("ทบทวนคณิต", tasks).id, "math");
  });

  test("an unrelated phrase still matches nothing", function () {
    var tasks = [
      { id: "hw", title: "ส่งการบ้านเลข", done: false },
      { id: "gym", title: "ไปฟิตเนส", done: false }
    ];
    assertNull(V.findTaskByTitle("ไปเที่ยวทะเลกับเพื่อน", tasks));
    assertNull(V.findTaskByTitle("xyz", tasks));
  });

  test("scoreTitleMatch ranks containment above fuzzy above nothing", function () {
    var exact = V.scoreTitleMatch("ซื้อนม", "ซื้อนม");
    var keyword = V.scoreTitleMatch("การบ้าน", "ส่งการบ้านเลข");
    var fuzzy = V.scoreTitleMatch("อ่านหนังสืออังกฤษ", "อ่านหนังสือภาษาอังกฤษ");
    var none = V.scoreTitleMatch("ไปทะเล", "ส่งการบ้าน");
    assertEqual(exact, 1);
    assertTrue(keyword > fuzzy, "a contained keyword should beat a fuzzy shape match");
    assertTrue(fuzzy > none, "a close miss should beat an unrelated phrase");
    assertTrue(none < V.MATCH_MIN, "unrelated must fall under the match threshold");
    assertTrue(keyword >= 0.8 && keyword <= 1, "keyword score sits in the containment band");
  });

  test("two equally good candidates are reported as ambiguous, not guessed", function () {
    var tasks = [
      { id: "a", title: "ประชุมทีมเช้า", done: false },
      { id: "b", title: "ประชุมทีมบ่าย", done: false },
      { id: "c", title: "ซื้อนม", done: false }
    ];
    var m = V.findTaskMatches("ประชุมทีม", tasks);
    assertTrue(m.length >= 2, "both meetings should be candidates");
    assertTrue(V.isAmbiguousMatch(m), "two near-identical titles must read as ambiguous");

    var clear = V.findTaskMatches("ซื้อนม", tasks);
    assertTrue(!V.isAmbiguousMatch(clear), "a single obvious match must not be ambiguous");
  });

  test("dice similarity behaves sanely at the edges", function () {
    assertEqual(V.diceCoefficient("abc", "abc"), 1);
    assertEqual(V.diceCoefficient("abc", "xyz"), 0);
    assertEqual(V.diceCoefficient("", ""), 1);
    assertEqual(V.diceCoefficient("a", "b"), 0);
    assertTrue(V.diceCoefficient("การบ้านเลข", "การบ้าน") > 0.6);
  });

  test("matching survives a big list without picking something random", function () {
    var tasks = [];
    for (var i = 0; i < 200; i++) tasks.push({ id: "t" + i, title: "งานที่ " + i, done: false });
    tasks.push({ id: "target", title: "ส่งรายงานการเงิน", done: false });
    assertEqual(V.findTaskByTitle("รายงานการเงิน", tasks).id, "target");
    assertNull(V.findTaskByTitle("ปลูกต้นไม้ในสวนหลังบ้าน", tasks));
  });

  /* ================= the widened conversation ================= */

  test("the new conversational topics all route to their own pool", function () {
    var cases = [
      ["อรุณสวัสดิ์", "chat.morning"],
      ["จะนอนแล้วนะ", "chat.goodnight"],
      ["งานเยอะมาก", "chat.stress"],
      ["สอบผ่านแล้ว", "chat.proud"],
      ["ขอกำลังใจหน่อย", "chat.encourage"],
      ["ไม่สบายเลย", "chat.sick"],
      ["หงุดหงิดมาก", "chat.angry"],
      ["โคตรเซ็งเลย", "chat.angry"],
      ["กินอะไรดี", "chat.whatToEat"],
      ["แนะนำเพลงหน่อย", "chat.music"],
      ["ฝนตกหนักมาก", "chat.weatherTalk"],
      ["พรุ่งนี้ฝนตกไหม", "chat.weatherAsk"],
      ["ขอโทษนะ", "chat.sorry"],
      ["สวยจัง", "chat.compliment"],
      ["จริงเหรอ", "chat.doubt"],
      ["ทำอะไรอยู่", "chat.smallTalk"],
      ["อายุเท่าไหร่", "chat.age"],
      ["มีความรู้สึกไหม", "chat.feelings"],
      ["อ่านหนังสือไม่เข้าหัว", "chat.study"],
      ["เงินหมดแล้ว", "chat.money"],
      ["ไม่รู้จะทำอะไรกับอนาคต", "chat.future"],
      ["ทำอะไรได้บ้าง", "chat.capabilities"],
      ["วันนี้วันอะไร", "query.date"]
    ];
    cases.forEach(function (c) {
      var got = V.parseIntent(c[0], { now: NOW, categories: cats() });
      assertEqual(got.intent, c[1], 'transcript "' + c[0] + '"');
    });
  });

  test("widening the vocabulary did not break the original commands", function () {
    var cases = [
      ["สรุป", "briefing"],
      ["เพิ่มงาน ซื้อนม", "task.add"],
      ["กาแฟ 60 บาท", "money.add"],
      ["จับเวลา 25 นาที", "timer.start"],
      ["เปิดปฏิทิน", "nav.calendar"],
      ["เงิน", "nav.money"],
      ["วันนี้มีงานอะไรบ้าง", "query.tasksToday"],
      ["ต้องทำอะไรบ้าง", "query.tasksToday"],
      ["เสร็จแล้ว", "task.done"]
    ];
    cases.forEach(function (c) {
      assertEqual(V.parseIntent(c[0], { now: NOW, categories: cats() }).intent, c[1], c[0]);
    });
  });

  test("every new conversational topic is still read-only", function () {
    Object.keys(V.RESPONSES).forEach(function (k) {
      assertTrue(!V.isWriteIntent("chat." + k), "chat." + k + " must never be a write intent");
    });
    ["อรุณสวัสดิ์","งานเยอะมาก","โคตรเซ็ง","เงินหมดแล้ว","อายุเท่าไหร่","ฝนจะตกไหม"].forEach(function (t) {
      assertTrue(!V.isWriteIntent(V.parseIntent(t, { now: NOW }).intent), t);
    });
  });

  test("every chat intent the router can emit has a pool behind it", function () {
    var probes = ["อรุณสวัสดิ์","จะนอนแล้ว","งานเยอะ","สอบผ่าน","ขอกำลังใจ","ไม่สบาย","หงุดหงิด",
      "โคตร","กินอะไรดี","แนะนำเพลง","ฝนตก","ฝนจะตกไหม","หายไปไหน","ขอโทษ","สวยจัง","จริงเหรอ",
      "ทำอะไรอยู่","อายุเท่าไหร่","เหงาไหม","จำไม่ได้","ถังแตก","อนาคต","ทำอะไรได้บ้าง",
      "สวัสดี","เหนื่อย","เศร้า","ดีใจ","เบื่อ","หิว","ง่วง","ขี้เกียจ","คุยกันหน่อย","เล่ามุก","บาย",
      "ขอบคุณ","เก่งมาก","คิดถึง","นายคือใคร","เป็นไงบ้าง"];
    probes.forEach(function (t) {
      var intent = V.parseIntent(t, { now: NOW }).intent;
      if (intent.indexOf("chat.") !== 0) return;
      var key = intent.slice(5);
      assertTrue(Array.isArray(V.RESPONSES[key]) && V.RESPONSES[key].length >= 2,
        'intent ' + intent + ' (from "' + t + '") has no pool');
    });
  });

  /* ================= confidence gating ================= */

  test("confidence bands match what the device measured", function () {
    // misheard results on device fell at 0.49-0.63
    assertEqual(V.gate("task.add", 0.49, {}), "retry");
    assertEqual(V.gate("nav.money", 0.50, {}), "retry");
    // the uncertain middle: writes ask first, reads just go
    assertEqual(V.gate("task.add", 0.63, {}), "confirm");
    assertEqual(V.gate("nav.calendar", 0.63, {}), "act");
    assertEqual(V.gate("chat.tired", 0.63, {}), "act");
    // correct results on device were 0.82-1.00
    assertEqual(V.gate("task.add", 0.99, {}), "act");
  });

  test("a large expense always confirms, however sure the transcript was", function () {
    assertEqual(V.gate("money.add", 1.0, { amount: 60 }), "act");
    assertEqual(V.gate("money.add", 1.0, { amount: V.CONFIRM_BAHT }), "confirm");
    assertEqual(V.gate("money.add", 1.0, { amount: 15000 }), "confirm");
  });

  test("a missing confidence score does not block anything", function () {
    assertEqual(V.gate("task.add", undefined, {}), "act");
    assertEqual(V.gate("nav.money", null, {}), "act");
  });

  /* ================= anti-repetition ================= */

  test("the picker never repeats a line twice in a row", function () {
    var pools = { p: ["a", "b", "c", "d", "e"] };
    var pick = V.createPicker(pools, { rng: Math.random });
    var prev = null;
    for (var i = 0; i < 300; i++) {
      var line = pick("p");
      assertTrue(line !== prev, "repeated " + line + " at iteration " + i);
      prev = line;
    }
  });

  test("the picker avoids the whole recent window, not just the last line", function () {
    var pools = { p: ["a", "b", "c", "d", "e", "f", "g", "h"] };
    var pick = V.createPicker(pools, { rng: Math.random });
    var seen = [];
    for (var i = 0; i < 200; i++) {
      var line = pick("p");
      var window = seen.slice(-4); // floor(8/2) = 4
      assertTrue(window.indexOf(line) === -1, "line " + line + " reappeared inside the window");
      seen.push(line);
    }
  });

  test("the picker terminates on tiny pools instead of looping", function () {
    var pick = V.createPicker({ one: ["only"], two: ["a", "b"] });
    assertEqual(pick("one"), "only");
    assertEqual(pick("one"), "only", "a single-line pool has nothing to alternate with");
    var a = pick("two"), b = pick("two"), c = pick("two");
    assertTrue(a !== b && b !== c, "a two-line pool must alternate");
    assertEqual(pick("missing"), "", "an unknown pool is empty, not an error");
  });

  test("the picker is deterministic given a seeded rng", function () {
    function seeded() { var n = 0; return function () { n += 0.37; return n % 1; }; }
    var first = [], second = [];
    var p1 = V.createPicker({ p: ["a", "b", "c", "d"] }, { rng: seeded() });
    var p2 = V.createPicker({ p: ["a", "b", "c", "d"] }, { rng: seeded() });
    for (var i = 0; i < 20; i++) { first.push(p1("p")); second.push(p2("p")); }
    assertEqual(first.join(","), second.join(","));
  });

  test("every response pool has enough lines to rotate", function () {
    Object.keys(V.RESPONSES).forEach(function (key) {
      var pool = V.RESPONSES[key];
      assertTrue(Array.isArray(pool) && pool.length >= 2, "pool " + key + " needs at least 2 lines");
      var unique = {};
      pool.forEach(function (line) {
        assertTrue(typeof line === "string" && line.trim().length > 0, "pool " + key + " has an empty line");
        assertTrue(!unique[line], "pool " + key + " repeats the line: " + line);
        unique[line] = true;
      });
    });
  });

  /* ================= short-term context ================= */

  test("context remembers the last task and expires on its own", function () {
    var ctx = V.createContext({ ttlMs: 90000 });
    var t0 = new Date(2026, 7, 15, 10, 0, 0);
    ctx.set("task-1", "task.add", t0);
    assertEqual(ctx.get(new Date(t0.getTime() + 30000)).taskId, "task-1");
    assertNull(ctx.get(new Date(t0.getTime() + 90001)), "context must expire");
    assertNull(ctx.get(new Date(t0.getTime() + 30000)), "expiry is permanent, not a stale read");
  });

  test("context can be cleared and starts empty", function () {
    var ctx = V.createContext();
    assertNull(ctx.get(new Date()));
    ctx.set("x", "task.add", new Date());
    ctx.clear();
    assertNull(ctx.get(new Date()));
  });

  /* ================= report ================= */

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.filter(function (r) { return !r.ok; }).length;
  var summaryLines = results.map(function (r) {
    return (r.ok ? "PASS" : "FAIL") + " — " + r.name + (r.ok ? "" : "\n       " + r.error);
  });
  var summary = summaryLines.join("\n") + "\n\n" + passed + " passed, " + failed + " failed, " + results.length + " total";

  window.__buamVoiceTestResults = { passed: passed, failed: failed, total: results.length, results: results, summary: summary };
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
