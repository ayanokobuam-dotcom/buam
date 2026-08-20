/* buam-money.js — data access + business logic for the Money tab.
   Loaded as a global script in index.html (window.BuamMoney) and via
   require() from buam-money.test.js (module.exports). No DOM access here —
   UI rendering/event wiring lives in index.html's inline <script>. */
(function () {
  "use strict";

  var KEYS = {
    settings: "buam-money-settings-v1",
    budgetGroups: "buam-money-budget-groups-v1",
    categories: "buam-money-categories-v1",
    transactions: "buam-money-transactions-v1",
    monthlyBudgets: "buam-money-monthly-budgets-v1",
    recurring: "buam-money-recurring-v1"
  };

  var TYPES = ["income", "expense", "investment"];
  var NEAR_THRESHOLD = 0.8;
  var STATUS_RANK = { normal: 0, near: 1, reached: 2, over: 3 };
  var RECURRING_SAFETY_CAP = 500;
  var EXPORT_VERSION = 1;

  /* ---------------- util ---------------- */

  function uid(prefix) {
    return (prefix || "m") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  function nowIso() { return new Date().toISOString(); }

  function isFiniteNumber(n) { return typeof n === "number" && Number.isFinite(n); }

  function toMinor(baht) {
    if (!isFiniteNumber(baht)) return NaN;
    return Math.round(baht * 100);
  }
  function toBaht(minor) { return minor / 100; }

  function formatBaht(minor) {
    return toBaht(minor).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatPct(fraction) {
    if (fraction == null || !isFiniteNumber(fraction)) return "—";
    return (Math.round(fraction * 1000) / 10) + "%";
  }

  function toDateStr(d) {
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function isValidDateStr(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + "T00:00:00");
    return !isNaN(d.getTime()) && s === toDateStr(d);
  }
  function todayStr() { return toDateStr(new Date()); }
  function monthKeyOf(dateStr) { return dateStr.slice(0, 7); }
  function prevMonthKey(mKey) {
    var parts = mKey.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 2, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function nextMonthKey(mKey) {
    var parts = mKey.split("-").map(Number);
    var d = new Date(parts[0], parts[1], 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function addDaysStr(dateStr, days) {
    var d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + days);
    return toDateStr(d);
  }
  function addMonthsStr(dateStr, months) {
    var d = new Date(dateStr + "T00:00:00");
    d.setMonth(d.getMonth() + months);
    return toDateStr(d);
  }
  function isoWeekKey(dateStr) {
    var d = new Date(dateStr + "T00:00:00");
    var day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day + 3);
    var firstThursday = new Date(d.getFullYear(), 0, 4);
    var diff = (d - firstThursday) / 86400000;
    var week = 1 + Math.round(diff / 7);
    return d.getFullYear() + "-W" + String(week).padStart(2, "0");
  }

  /* ---------------- storage ---------------- */

  function hasStorage() {
    try {
      if (typeof localStorage === "undefined") return false;
      var t = "__buam_money_probe__";
      localStorage.setItem(t, "1");
      localStorage.removeItem(t);
      return true;
    } catch (e) { return false; }
  }

  function readJSON(key, fallback) {
    try {
      if (typeof localStorage === "undefined") return fallback;
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.error("[buam-money] read failed for", key, e);
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      if (typeof localStorage === "undefined") return { ok: false, error: "storage-unavailable" };
      localStorage.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      console.error("[buam-money] write failed for", key, e);
      return { ok: false, error: "storage-write-failed" };
    }
  }

  /* ---------------- defaults ---------------- */

  var DEFAULT_BUDGET_GROUPS = [
    { id: "grp-living", name: "Living", monthlyAmount: 900000, order: 0, type: "expense" },
    { id: "grp-investment", name: "Investment", monthlyAmount: 300000, order: 1, type: "investment" },
    { id: "grp-selfdev", name: "Self Development", monthlyAmount: 75000, order: 2, type: "expense" },
    { id: "grp-relationship", name: "Relationship & Fun", monthlyAmount: 125000, order: 3, type: "expense" }
  ];
  var DEFAULT_SETTINGS = { monthlyIncome: 1400000 };

  function defaultCategories() {
    return {
      income: [
        { id: "inc-allowance", name: "เงินเดือน/ค่าขนม", type: "income", builtIn: true, archived: false },
        { id: "inc-work", name: "รายได้จากงาน", type: "income", builtIn: true, archived: false },
        { id: "inc-other", name: "รายได้อื่น ๆ", type: "income", builtIn: true, archived: false }
      ],
      expense: [
        { id: "exp-food", name: "อาหาร", type: "expense", groupId: "grp-living", builtIn: true, archived: false },
        { id: "exp-transport", name: "เดินทาง", type: "expense", groupId: "grp-living", builtIn: true, archived: false },
        { id: "exp-supplies", name: "ของใช้", type: "expense", groupId: "grp-living", builtIn: true, archived: false },
        { id: "exp-study", name: "การเรียน", type: "expense", groupId: "grp-selfdev", builtIn: true, archived: false },
        { id: "exp-aisoftware", name: "AI / Software", type: "expense", groupId: "grp-selfdev", builtIn: true, archived: false },
        { id: "exp-fun", name: "ความบันเทิง", type: "expense", groupId: "grp-relationship", builtIn: true, archived: false },
        { id: "exp-relationship", name: "แฟน/ความสัมพันธ์", type: "expense", groupId: "grp-relationship", builtIn: true, archived: false },
        { id: "exp-other", name: "อื่น ๆ", type: "expense", groupId: "grp-living", builtIn: true, archived: false }
      ],
      investment: [
        { id: "inv-fund", name: "กองทุน", type: "investment", groupId: "grp-investment", builtIn: true, archived: false },
        { id: "inv-stock", name: "หุ้น", type: "investment", groupId: "grp-investment", builtIn: true, archived: false },
        { id: "inv-etf", name: "ETF", type: "investment", groupId: "grp-investment", builtIn: true, archived: false },
        { id: "inv-savings", name: "เงินออมเพื่อการลงทุน", type: "investment", groupId: "grp-investment", builtIn: true, archived: false },
        { id: "inv-other", name: "อื่น ๆ", type: "investment", groupId: "grp-investment", builtIn: true, archived: false }
      ]
    };
  }

  /* ---------------- load / save ---------------- */

  function loadSettings() {
    var s = readJSON(KEYS.settings, null);
    if (s && isFiniteNumber(s.monthlyIncome)) return s;
    var seeded = Object.assign({}, DEFAULT_SETTINGS);
    writeJSON(KEYS.settings, seeded);
    return seeded;
  }
  function saveSettings(settings) { return writeJSON(KEYS.settings, settings); }

  function loadBudgetGroups() {
    var g = readJSON(KEYS.budgetGroups, null);
    if (Array.isArray(g) && g.length) {
      // older saves predate per-group type: migrate the old investment
      // catch-all flag into the new type field, default the rest to expense
      g.forEach(function (x) { if (!x.type) x.type = x.isInvestmentGroup ? "investment" : "expense"; });
      return g;
    }
    var seeded = DEFAULT_BUDGET_GROUPS.map(function (x) { return Object.assign({}, x); });
    writeJSON(KEYS.budgetGroups, seeded);
    return seeded;
  }
  function saveBudgetGroups(groups) { return writeJSON(KEYS.budgetGroups, groups); }

  function loadCategories() {
    var c = readJSON(KEYS.categories, null);
    if (c && c.income && c.expense && c.investment) return c;
    var seeded = defaultCategories();
    writeJSON(KEYS.categories, seeded);
    return seeded;
  }
  function saveCategories(cats) { return writeJSON(KEYS.categories, cats); }

  function loadTransactions() {
    var t = readJSON(KEYS.transactions, null);
    return Array.isArray(t) ? t : [];
  }
  function saveTransactions(txns) { return writeJSON(KEYS.transactions, txns); }

  function loadMonthlyBudgets() {
    var m = readJSON(KEYS.monthlyBudgets, null);
    return (m && typeof m === "object") ? m : {};
  }
  function saveMonthlyBudgets(m) { return writeJSON(KEYS.monthlyBudgets, m); }

  function loadRecurring() {
    var r = readJSON(KEYS.recurring, null);
    return Array.isArray(r) ? r : [];
  }
  function saveRecurring(r) { return writeJSON(KEYS.recurring, r); }

  function resetAllData() {
    writeJSON(KEYS.settings, Object.assign({}, DEFAULT_SETTINGS));
    writeJSON(KEYS.budgetGroups, DEFAULT_BUDGET_GROUPS.map(function (x) { return Object.assign({}, x); }));
    writeJSON(KEYS.categories, defaultCategories());
    writeJSON(KEYS.transactions, []);
    writeJSON(KEYS.monthlyBudgets, {});
    writeJSON(KEYS.recurring, []);
  }

  /* ---------------- categories ---------------- */

  function allCategories(categories) {
    return [].concat(categories.income, categories.expense, categories.investment);
  }
  function findCategory(categories, id) {
    return allCategories(categories).filter(function (c) { return c.id === id; })[0] || null;
  }
  function categoriesForType(categories, type) {
    return (categories[type] || []).filter(function (c) { return !c.archived; });
  }
  function isCategoryInUse(transactions, id) {
    return transactions.some(function (t) { return t.categoryId === id; });
  }
  function addCategory(categories, input) {
    var name = input.name, type = input.type, groupId = input.groupId;
    if (!name || !name.trim()) return { ok: false, error: "invalid-name" };
    if (TYPES.indexOf(type) === -1) return { ok: false, error: "invalid-type" };
    var cat = { id: uid("cat"), name: name.trim(), type: type, groupId: groupId || null, builtIn: false, archived: false };
    categories[type].push(cat);
    return { ok: true, category: cat };
  }
  function renameCategory(categories, id, name) {
    var cat = findCategory(categories, id);
    if (!cat) return { ok: false, error: "not-found" };
    if (!name || !name.trim()) return { ok: false, error: "invalid-name" };
    cat.name = name.trim();
    return { ok: true };
  }
  function setCategoryGroup(categories, id, groupId) {
    var cat = findCategory(categories, id);
    if (!cat) return { ok: false, error: "not-found" };
    cat.groupId = groupId || null;
    return { ok: true };
  }
  // one-time upgrade path: pre-existing saves may have investment categories
  // with no groupId (the old Investment group auto-caught every investment
  // transaction regardless of category, so nothing needed linking before).
  // Links them to whichever budget group is typed "investment", if any.
  function migrateUnlinkedInvestmentCategories(categories, budgetGroups) {
    var invGroup = budgetGroups.filter(function (g) { return g.type === "investment"; })[0];
    if (!invGroup) return false;
    var changed = false;
    (categories.investment || []).forEach(function (c) {
      if (!c.groupId) { c.groupId = invGroup.id; changed = true; }
    });
    return changed;
  }
  function deleteCategory(categories, transactions, id) {
    var cat = findCategory(categories, id);
    if (!cat) return { ok: false, error: "not-found" };
    if (isCategoryInUse(transactions, id)) {
      cat.archived = true;
      return { ok: true, archived: true };
    }
    categories[cat.type] = categories[cat.type].filter(function (c) { return c.id !== id; });
    return { ok: true, archived: false };
  }

  /* ---------------- budget groups ---------------- */

  function nextGroupOrder(budgetGroups) {
    return budgetGroups.reduce(function (max, g) {
      return Math.max(max, isFiniteNumber(g.order) ? g.order : 0);
    }, -1) + 1;
  }
  function sortBudgetGroups(budgetGroups) {
    budgetGroups.sort(function (a, b) {
      return (isFiniteNumber(a.order) ? a.order : 0) - (isFiniteNumber(b.order) ? b.order : 0);
    });
    // re-stamp sequential order values every time — older data (or groups
    // added/deleted before this field was normalized) can carry duplicate
    // order numbers, which makes an up/down swap trade two equal values and
    // look like it did nothing. This heals that on every sort, not just once.
    budgetGroups.forEach(function (g, i) { g.order = i; });
    return budgetGroups;
  }
  function reorderBudgetGroup(budgetGroups, id, direction) {
    sortBudgetGroups(budgetGroups);
    var i = budgetGroups.findIndex(function (g) { return g.id === id; });
    if (i === -1) return { ok: false, error: "not-found" };
    var j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= budgetGroups.length) return { ok: false, error: "boundary" };
    var tmp = budgetGroups[i].order;
    budgetGroups[i].order = budgetGroups[j].order;
    budgetGroups[j].order = tmp;
    sortBudgetGroups(budgetGroups);
    return { ok: true };
  }
  function addBudgetGroup(budgetGroups, input) {
    var name = input.name, monthlyAmount = input.monthlyAmount, type = input.type || "expense";
    if (!name || !name.trim()) return { ok: false, error: "invalid-name" };
    var amt = Number(monthlyAmount);
    if (!isFiniteNumber(amt) || amt < 0) return { ok: false, error: "invalid-amount" };
    if (TYPES.indexOf(type) === -1) return { ok: false, error: "invalid-type" };
    var group = { id: uid("grp"), name: name.trim(), monthlyAmount: toMinor(amt), order: nextGroupOrder(budgetGroups), type: type };
    budgetGroups.push(group);
    return { ok: true, group: group };
  }
  function updateBudgetGroup(budgetGroups, id, input) {
    var g = budgetGroups.filter(function (x) { return x.id === id; })[0];
    if (!g) return { ok: false, error: "not-found" };
    if (input.name != null) {
      if (!input.name.trim()) return { ok: false, error: "invalid-name" };
      g.name = input.name.trim();
    }
    if (input.monthlyAmount != null) {
      var amt = Number(input.monthlyAmount);
      if (!isFiniteNumber(amt) || amt < 0) return { ok: false, error: "invalid-amount" };
      g.monthlyAmount = toMinor(amt);
    }
    return { ok: true, group: g };
  }
  function deleteBudgetGroup(budgetGroups, categories, id) {
    var idx = budgetGroups.findIndex(function (g) { return g.id === id; });
    if (idx === -1) return { ok: false, error: "not-found" };
    allCategories(categories).forEach(function (c) { if (c.groupId === id) c.groupId = null; });
    budgetGroups.splice(idx, 1);
    return { ok: true };
  }

  /* ---------------- settings ---------------- */

  function updateSettings(settings, input) {
    if (input.monthlyIncome != null) {
      var amt = Number(input.monthlyIncome);
      if (!isFiniteNumber(amt) || amt < 0) return { ok: false, error: "invalid-amount" };
      settings.monthlyIncome = toMinor(amt);
    }
    return { ok: true, settings: settings };
  }

  /* ---------------- validation ---------------- */

  function validateTransactionInput(input, categories) {
    var errors = [];
    var amountBaht = Number(input.amount);
    if (!isFiniteNumber(amountBaht) || amountBaht <= 0) errors.push("จำนวนเงินต้องมากกว่า 0");
    if (TYPES.indexOf(input.type) === -1) errors.push("ประเภทรายการไม่ถูกต้อง");
    if (!input.date || !isValidDateStr(input.date)) errors.push("วันที่ไม่ถูกต้อง");
    if (TYPES.indexOf(input.type) !== -1) {
      var cat = findCategory(categories, input.categoryId);
      if (!cat || cat.type !== input.type || cat.archived) errors.push("หมวดหมู่ไม่ถูกต้องหรือถูกเก็บถาวรแล้ว");
    }
    return { valid: errors.length === 0, errors: errors };
  }

  function validateRecurringInput(input, categories) {
    var errors = [];
    var amountBaht = Number(input.amount);
    if (!isFiniteNumber(amountBaht) || amountBaht <= 0) errors.push("จำนวนเงินต้องมากกว่า 0");
    if (["weekly", "biweekly", "monthly"].indexOf(input.frequency) === -1) errors.push("ความถี่ไม่ถูกต้อง");
    if (!input.startDate || !isValidDateStr(input.startDate)) errors.push("วันเริ่มต้นไม่ถูกต้อง");
    if (input.endDate && !isValidDateStr(input.endDate)) errors.push("วันสิ้นสุดไม่ถูกต้อง");
    if (input.endDate && input.startDate && isValidDateStr(input.startDate) && isValidDateStr(input.endDate) && input.endDate < input.startDate) {
      errors.push("วันสิ้นสุดต้องไม่ก่อนวันเริ่มต้น");
    }
    var cat = findCategory(categories, input.categoryId);
    if (!cat || cat.type !== "income" || cat.archived) errors.push("หมวดหมู่รายรับไม่ถูกต้อง");
    return { valid: errors.length === 0, errors: errors };
  }

  function validateImportPayload(json) {
    var data;
    try { data = typeof json === "string" ? JSON.parse(json) : json; }
    catch (e) { return { valid: false, error: "invalid-json" }; }
    if (!data || typeof data !== "object") return { valid: false, error: "invalid-schema" };
    if (!Array.isArray(data.transactions)) return { valid: false, error: "invalid-schema" };
    if (!data.settings || !isFiniteNumber(data.settings.monthlyIncome)) return { valid: false, error: "invalid-schema" };
    if (!Array.isArray(data.budgetGroups)) return { valid: false, error: "invalid-schema" };
    if (!data.categories || !Array.isArray(data.categories.income) || !Array.isArray(data.categories.expense) || !Array.isArray(data.categories.investment)) {
      return { valid: false, error: "invalid-schema" };
    }
    for (var i = 0; i < data.transactions.length; i++) {
      var t = data.transactions[i];
      if (!t || !isFiniteNumber(t.amount) || TYPES.indexOf(t.type) === -1 || !isValidDateStr(t.date)) {
        return { valid: false, error: "invalid-transaction" };
      }
    }
    return { valid: true, data: data };
  }

  /* ---------------- transactions ---------------- */

  function addTransaction(transactions, categories, input) {
    var check = validateTransactionInput(input, categories);
    if (!check.valid) return { ok: false, errors: check.errors };
    var now = nowIso();
    var txn = {
      id: uid("txn"),
      amount: toMinor(Number(input.amount)),
      type: input.type,
      categoryId: input.categoryId,
      note: (input.note || "").trim().slice(0, 300),
      date: input.date,
      createdAt: now,
      updatedAt: now
    };
    if (input.type === "investment" && input.asset) txn.asset = String(input.asset).trim().slice(0, 100);
    transactions.push(txn);
    return { ok: true, transaction: txn };
  }

  function updateTransaction(transactions, categories, id, input) {
    var txn = transactions.filter(function (t) { return t.id === id; })[0];
    if (!txn) return { ok: false, errors: ["ไม่พบรายการ"] };
    var check = validateTransactionInput(input, categories);
    if (!check.valid) return { ok: false, errors: check.errors };
    txn.amount = toMinor(Number(input.amount));
    txn.type = input.type;
    txn.categoryId = input.categoryId;
    txn.note = (input.note || "").trim().slice(0, 300);
    txn.date = input.date;
    txn.updatedAt = nowIso();
    if (input.type === "investment" && input.asset) txn.asset = String(input.asset).trim().slice(0, 100);
    else delete txn.asset;
    return { ok: true, transaction: txn };
  }

  function deleteTransaction(transactions, id) {
    var idx = transactions.findIndex(function (t) { return t.id === id; });
    if (idx === -1) return { ok: false };
    transactions.splice(idx, 1);
    return { ok: true };
  }

  function queryTransactions(transactions, opts) {
    opts = opts || {};
    var list = transactions.slice();
    if (opts.type) list = list.filter(function (t) { return t.type === opts.type; });
    if (opts.categoryId) list = list.filter(function (t) { return t.categoryId === opts.categoryId; });
    if (opts.from) list = list.filter(function (t) { return t.date >= opts.from; });
    if (opts.to) list = list.filter(function (t) { return t.date <= opts.to; });
    if (opts.search && opts.search.trim()) {
      var q = opts.search.trim().toLowerCase();
      var catNameIndex = {};
      if (opts.categories) {
        allCategories(opts.categories).forEach(function (c) { catNameIndex[c.id] = c.name.toLowerCase(); });
      }
      list = list.filter(function (t) {
        if ((t.note || "").toLowerCase().indexOf(q) !== -1) return true;
        if (t.date.indexOf(q) !== -1) return true;
        if (String(toBaht(t.amount)).indexOf(q) !== -1) return true;
        if ((catNameIndex[t.categoryId] || "").indexOf(q) !== -1) return true;
        return false;
      });
    }
    var sortBy = opts.sortBy || "date";
    var dir = opts.sortDir === "asc" ? 1 : -1;
    list.sort(function (a, b) {
      if (sortBy === "amount") return (a.amount - b.amount) * dir;
      if (a.date === b.date) return (a.createdAt < b.createdAt ? -1 : 1) * dir;
      return (a.date < b.date ? -1 : 1) * dir;
    });
    return list;
  }

  /* ---------------- monthly budgets ---------------- */

  function cloneGroupsAsBudget(groups) {
    return groups.map(function (g) { return { groupId: g.id, amount: g.monthlyAmount }; });
  }
  function getMonthlyBudget(monthlyBudgets, budgetGroups, settings, mKey) {
    if (monthlyBudgets[mKey]) return monthlyBudgets[mKey];
    return { income: settings.monthlyIncome, groups: cloneGroupsAsBudget(budgetGroups) };
  }
  function ensureMonthlyBudget(monthlyBudgets, budgetGroups, settings, mKey) {
    if (!monthlyBudgets[mKey]) monthlyBudgets[mKey] = getMonthlyBudget(monthlyBudgets, budgetGroups, settings, mKey);
    return monthlyBudgets[mKey];
  }
  function updateMonthlyBudget(monthlyBudgets, mKey, patch) {
    var existing = monthlyBudgets[mKey] || { income: 0, groups: [] };
    monthlyBudgets[mKey] = Object.assign({}, existing, patch);
    return monthlyBudgets[mKey];
  }

  /* ---------------- budget usage / dashboard ---------------- */

  function spentByGroup(transactions, categories, budgetGroups, mKey) {
    var catIndex = {};
    allCategories(categories).forEach(function (c) { catIndex[c.id] = c; });
    var byGroup = {};
    transactions.forEach(function (t) {
      if (monthKeyOf(t.date) !== mKey) return;
      var cat = catIndex[t.categoryId];
      var groupId = (cat && cat.groupId) ? cat.groupId : null;
      if (!groupId) return;
      byGroup[groupId] = (byGroup[groupId] || 0) + t.amount;
    });
    return byGroup;
  }

  function calcGroupUsage(transactions, categories, budgetGroups, monthlyBudget, mKey) {
    var spent = spentByGroup(transactions, categories, budgetGroups, mKey);
    var budgetByGroupId = {};
    (monthlyBudget.groups || []).forEach(function (g) { budgetByGroupId[g.groupId] = g.amount; });
    return budgetGroups.map(function (g) {
      var budget = Object.prototype.hasOwnProperty.call(budgetByGroupId, g.id) ? budgetByGroupId[g.id] : g.monthlyAmount;
      var spentAmt = spent[g.id] || 0;
      var remaining = budget - spentAmt;
      var pct = budget > 0 ? spentAmt / budget : null;
      var status = "normal";
      if (budget <= 0 && spentAmt > 0) status = "over";
      else if (budget > 0 && spentAmt === budget) status = "reached";
      else if (pct !== null && pct > 1) status = "over";
      else if (pct !== null && pct >= NEAR_THRESHOLD) status = "near";
      return { groupId: g.id, name: g.name, budget: budget, spent: spentAmt, remaining: remaining, pct: pct, type: g.type || "expense", status: status };
    });
  }

  function calcDashboard(transactions, mKey, monthlyBudget) {
    var income = 0, expense = 0, investment = 0;
    transactions.forEach(function (t) {
      if (monthKeyOf(t.date) !== mKey) return;
      if (t.type === "income") income += t.amount;
      else if (t.type === "expense") expense += t.amount;
      else if (t.type === "investment") investment += t.amount;
    });
    var remaining = income - expense - investment;
    var savingsRate = income > 0 ? remaining / income : null;
    var investmentRate = income > 0 ? investment / income : null;
    return {
      monthKey: mKey, income: income, expense: expense, investment: investment, remaining: remaining,
      savingsRate: savingsRate, investmentRate: investmentRate,
      budgetIncome: monthlyBudget ? monthlyBudget.income : null
    };
  }

  function calcMonthComparison(dashCurrent, dashPrev) {
    if (!dashPrev) return null;
    function delta(cur, prev) {
      if (prev === 0) return cur === 0 ? 0 : null;
      return (cur - prev) / Math.abs(prev);
    }
    return {
      incomeDelta: delta(dashCurrent.income, dashPrev.income),
      expenseDelta: delta(dashCurrent.expense, dashPrev.expense),
      investmentDelta: delta(dashCurrent.investment, dashPrev.investment),
      savingsRateDelta: (dashCurrent.savingsRate != null && dashPrev.savingsRate != null) ? dashCurrent.savingsRate - dashPrev.savingsRate : null,
      investmentRateDelta: (dashCurrent.investmentRate != null && dashPrev.investmentRate != null) ? dashCurrent.investmentRate - dashPrev.investmentRate : null
    };
  }

  function topSpendingCategory(transactions, categories, mKey) {
    var totals = {};
    transactions.forEach(function (t) {
      if (monthKeyOf(t.date) !== mKey || t.type !== "expense") return;
      totals[t.categoryId] = (totals[t.categoryId] || 0) + t.amount;
    });
    var best = null;
    Object.keys(totals).forEach(function (cid) {
      if (!best || totals[cid] > best.amount) best = { categoryId: cid, amount: totals[cid] };
    });
    if (!best) return null;
    var cat = findCategory(categories, best.categoryId);
    return { categoryId: best.categoryId, name: cat ? cat.name : "?", amount: best.amount };
  }

  /* ---------------- analytics ---------------- */

  function aggregateByPeriod(transactions, granularity, from, to) {
    var filtered = transactions.filter(function (t) { return (!from || t.date >= from) && (!to || t.date <= to); });
    var buckets = {};
    filtered.forEach(function (t) {
      var key;
      if (granularity === "day") key = t.date;
      else if (granularity === "week") key = isoWeekKey(t.date);
      else key = monthKeyOf(t.date);
      if (!buckets[key]) buckets[key] = { key: key, income: 0, expense: 0, investment: 0 };
      buckets[key][t.type] += t.amount;
    });
    return Object.keys(buckets).sort().map(function (k) { return buckets[k]; });
  }

  function categoryBreakdown(transactions, categories, type, from, to) {
    var filtered = transactions.filter(function (t) {
      return t.type === type && (!from || t.date >= from) && (!to || t.date <= to);
    });
    var totals = {};
    filtered.forEach(function (t) { totals[t.categoryId] = (totals[t.categoryId] || 0) + t.amount; });
    var grandTotal = Object.keys(totals).reduce(function (sum, k) { return sum + totals[k]; }, 0);
    return Object.keys(totals).map(function (cid) {
      var cat = findCategory(categories, cid);
      var amount = totals[cid];
      return { categoryId: cid, name: cat ? cat.name : "(deleted)", amount: amount, pct: grandTotal > 0 ? amount / grandTotal : 0 };
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  /* ---------------- insights (rule-based, no AI) ---------------- */

  function generateInsights(ctx) {
    var dashCurrent = ctx.dashCurrent, dashPrev = ctx.dashPrev, groupUsages = ctx.groupUsages || [], expenseBreakdown = ctx.expenseBreakdown || [];
    var insights = [];
    var food = expenseBreakdown.filter(function (c) { return c.name === "อาหาร"; })[0];
    if (food && dashCurrent.expense > 0 && (food.amount / dashCurrent.expense) > 0.4) {
      insights.push({ type: "info", text: "ค่าอาหารเป็นสัดส่วนใหญ่ของรายจ่ายเดือนนี้" });
    }
    if (dashPrev && dashPrev.investmentRate != null && dashCurrent.investmentRate != null && dashCurrent.investmentRate > dashPrev.investmentRate) {
      insights.push({ type: "positive", text: "อัตราการลงทุนของคุณเพิ่มขึ้นจากเดือนก่อน" });
    }
    groupUsages.forEach(function (g) {
      if (g.status === "over") insights.push({ type: "warning", text: 'หมวด "' + g.name + '" ใช้เกินงบที่ตั้งไว้' });
    });
    if (dashPrev && dashCurrent.expense < dashPrev.expense) {
      insights.push({ type: "positive", text: "รายจ่ายเดือนนี้ลดลงเมื่อเทียบกับเดือนก่อน" });
    }
    return insights;
  }

  /* ---------------- recurring income ---------------- */

  function nextOccurrence(dateStr, frequency) {
    if (frequency === "weekly") return addDaysStr(dateStr, 7);
    if (frequency === "biweekly") return addDaysStr(dateStr, 14);
    return addMonthsStr(dateStr, 1);
  }

  function dueRecurringOccurrences(rule, today) {
    var dates = [];
    var cursor = rule.lastGeneratedDate ? nextOccurrence(rule.lastGeneratedDate, rule.frequency) : rule.startDate;
    var guard = 0;
    while (cursor <= today && guard < RECURRING_SAFETY_CAP) {
      if (rule.endDate && cursor > rule.endDate) break;
      dates.push(cursor);
      cursor = nextOccurrence(cursor, rule.frequency);
      guard++;
    }
    return dates;
  }

  function runRecurringCatchUp(recurring, transactions, categories, today) {
    var created = [];
    recurring.forEach(function (rule) {
      if (rule.startDate > today) return;
      var dates = dueRecurringOccurrences(rule, today);
      dates.forEach(function (date) {
        var input = { amount: toBaht(rule.amount), type: "income", categoryId: rule.categoryId, note: rule.note || "", date: date };
        var res = addTransaction(transactions, categories, input);
        if (res.ok) {
          created.push(res.transaction);
          rule.lastGeneratedDate = date;
        }
      });
    });
    return created;
  }

  function addRecurring(recurringList, categories, input) {
    var check = validateRecurringInput(input, categories);
    if (!check.valid) return { ok: false, errors: check.errors };
    var rule = {
      id: uid("rec"),
      amount: toMinor(Number(input.amount)),
      categoryId: input.categoryId,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate || null,
      lastGeneratedDate: null,
      note: (input.note || "").trim().slice(0, 200)
    };
    recurringList.push(rule);
    return { ok: true, rule: rule };
  }
  function updateRecurring(recurringList, categories, id, input) {
    var rule = recurringList.filter(function (r) { return r.id === id; })[0];
    if (!rule) return { ok: false, errors: ["ไม่พบรายการ"] };
    var check = validateRecurringInput(input, categories);
    if (!check.valid) return { ok: false, errors: check.errors };
    rule.amount = toMinor(Number(input.amount));
    rule.categoryId = input.categoryId;
    rule.frequency = input.frequency;
    rule.startDate = input.startDate;
    rule.endDate = input.endDate || null;
    rule.note = (input.note || "").trim().slice(0, 200);
    return { ok: true, rule: rule };
  }
  function deleteRecurring(recurringList, id) {
    var idx = recurringList.findIndex(function (r) { return r.id === id; });
    if (idx === -1) return { ok: false };
    recurringList.splice(idx, 1);
    return { ok: true };
  }

  /* ---------------- export / import ---------------- */

  function csvEscape(s) {
    s = String(s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function exportTransactionsCSV(transactions, categories) {
    var header = ["id", "date", "type", "category", "amount_baht", "note", "asset"];
    var rows = transactions.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).map(function (t) {
      var cat = findCategory(categories, t.categoryId);
      return [t.id, t.date, t.type, csvEscape(cat ? cat.name : ""), toBaht(t.amount).toFixed(2), csvEscape(t.note || ""), csvEscape(t.asset || "")].join(",");
    });
    return [header.join(",")].concat(rows).join("\n");
  }

  function exportJSON(state) {
    return JSON.stringify({
      version: EXPORT_VERSION,
      exportedAt: nowIso(),
      settings: state.settings,
      budgetGroups: state.budgetGroups,
      categories: state.categories,
      transactions: state.transactions,
      monthlyBudgets: state.monthlyBudgets,
      recurring: state.recurring
    }, null, 2);
  }

  function importJSON(json) {
    var check = validateImportPayload(json);
    if (!check.valid) return { ok: false, error: check.error };
    var data = check.data;
    return {
      ok: true,
      state: {
        settings: data.settings,
        budgetGroups: data.budgetGroups,
        categories: data.categories,
        transactions: data.transactions,
        monthlyBudgets: data.monthlyBudgets || {},
        recurring: Array.isArray(data.recurring) ? data.recurring : []
      }
    };
  }

  function applyImport(importedState) {
    saveSettings(importedState.settings);
    saveBudgetGroups(importedState.budgetGroups);
    saveCategories(importedState.categories);
    saveTransactions(importedState.transactions);
    saveMonthlyBudgets(importedState.monthlyBudgets);
    saveRecurring(importedState.recurring);
  }

  /* ---------------- public API ---------------- */

  var BuamMoney = {
    KEYS: KEYS, TYPES: TYPES, NEAR_THRESHOLD: NEAR_THRESHOLD, STATUS_RANK: STATUS_RANK,
    DEFAULT_BUDGET_GROUPS: DEFAULT_BUDGET_GROUPS, DEFAULT_SETTINGS: DEFAULT_SETTINGS, defaultCategories: defaultCategories,

    uid: uid, toMinor: toMinor, toBaht: toBaht, formatBaht: formatBaht, formatPct: formatPct,
    isValidDateStr: isValidDateStr, toDateStr: toDateStr, todayStr: todayStr, monthKeyOf: monthKeyOf,
    prevMonthKey: prevMonthKey, nextMonthKey: nextMonthKey,

    hasStorage: hasStorage,
    loadSettings: loadSettings, saveSettings: saveSettings,
    loadBudgetGroups: loadBudgetGroups, saveBudgetGroups: saveBudgetGroups,
    loadCategories: loadCategories, saveCategories: saveCategories,
    loadTransactions: loadTransactions, saveTransactions: saveTransactions,
    loadMonthlyBudgets: loadMonthlyBudgets, saveMonthlyBudgets: saveMonthlyBudgets,
    loadRecurring: loadRecurring, saveRecurring: saveRecurring,
    resetAllData: resetAllData,

    allCategories: allCategories, findCategory: findCategory, categoriesForType: categoriesForType,
    isCategoryInUse: isCategoryInUse, addCategory: addCategory, renameCategory: renameCategory,
    setCategoryGroup: setCategoryGroup, deleteCategory: deleteCategory,
    migrateUnlinkedInvestmentCategories: migrateUnlinkedInvestmentCategories,

    addBudgetGroup: addBudgetGroup, updateBudgetGroup: updateBudgetGroup, deleteBudgetGroup: deleteBudgetGroup,
    sortBudgetGroups: sortBudgetGroups, reorderBudgetGroup: reorderBudgetGroup,
    updateSettings: updateSettings,

    validateTransactionInput: validateTransactionInput, validateRecurringInput: validateRecurringInput,
    validateImportPayload: validateImportPayload,

    addTransaction: addTransaction, updateTransaction: updateTransaction, deleteTransaction: deleteTransaction,
    queryTransactions: queryTransactions,

    cloneGroupsAsBudget: cloneGroupsAsBudget, getMonthlyBudget: getMonthlyBudget,
    ensureMonthlyBudget: ensureMonthlyBudget, updateMonthlyBudget: updateMonthlyBudget,

    calcGroupUsage: calcGroupUsage, calcDashboard: calcDashboard, calcMonthComparison: calcMonthComparison,
    topSpendingCategory: topSpendingCategory,

    aggregateByPeriod: aggregateByPeriod, categoryBreakdown: categoryBreakdown, generateInsights: generateInsights,

    nextOccurrence: nextOccurrence, dueRecurringOccurrences: dueRecurringOccurrences,
    runRecurringCatchUp: runRecurringCatchUp,
    addRecurring: addRecurring, updateRecurring: updateRecurring, deleteRecurring: deleteRecurring,

    exportJSON: exportJSON, exportTransactionsCSV: exportTransactionsCSV,
    importJSON: importJSON, applyImport: applyImport
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = BuamMoney;
  }
  if (typeof window !== "undefined") {
    window.BuamMoney = BuamMoney;
  }
})();
