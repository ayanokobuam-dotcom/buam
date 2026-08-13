/* buam-money.test.js — dependency-free tests for buam-money.js business logic.
   This machine has no Node.js install, so this file is written to run in
   EITHER environment with zero external assertion library:
     - Node (if ever available):  node buam-money.test.js
     - Browser: buam-money.test.html loads buam-money.js then this file
   Failures throw plain Errors; results are collected and reported at the end. */
(function () {
  "use strict";

  var BuamMoney = (typeof module !== "undefined" && typeof require === "function")
    ? require("./buam-money.js")
    : window.BuamMoney;

  var results = [];
  var current = null;

  function test(name, fn) {
    current = name;
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: e && e.message ? e.message : String(e) });
    }
    current = null;
  }

  function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg ? msg + " — " : "") + "expected " + JSON.stringify(expected) + " but got " + JSON.stringify(actual));
    }
  }
  function assertClose(actual, expected, epsilon, msg) {
    epsilon = epsilon == null ? 1e-9 : epsilon;
    if (Math.abs(actual - expected) > epsilon) {
      throw new Error((msg ? msg + " — " : "") + "expected ~" + expected + " but got " + actual);
    }
  }
  function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg || "expected truthy value");
  }
  function assertNull(v, msg) {
    if (v !== null) throw new Error((msg ? msg + " — " : "") + "expected null but got " + JSON.stringify(v));
  }

  function freshState() {
    var categories = BuamMoney.defaultCategories();
    var budgetGroups = BuamMoney.DEFAULT_BUDGET_GROUPS.map(function (g) { return Object.assign({}, g); });
    var settings = Object.assign({}, BuamMoney.DEFAULT_SETTINGS);
    return { categories: categories, budgetGroups: budgetGroups, settings: settings, transactions: [], monthlyBudgets: {}, recurring: [] };
  }

  /* ---------------- validation ---------------- */

  test("validateTransactionInput rejects amount <= 0, NaN, Infinity", function () {
    var s = freshState();
    [0, -5, NaN, Infinity, -Infinity].forEach(function (amt) {
      var res = BuamMoney.validateTransactionInput({ amount: amt, type: "expense", categoryId: "exp-food", date: "2026-08-01" }, s.categories);
      assertTrue(!res.valid, "amount " + amt + " should be invalid");
    });
  });

  test("validateTransactionInput rejects bad date and unknown category", function () {
    var s = freshState();
    var badDate = BuamMoney.validateTransactionInput({ amount: 100, type: "expense", categoryId: "exp-food", date: "not-a-date" }, s.categories);
    assertTrue(!badDate.valid, "bad date should be invalid");
    var badCat = BuamMoney.validateTransactionInput({ amount: 100, type: "expense", categoryId: "does-not-exist", date: "2026-08-01" }, s.categories);
    assertTrue(!badCat.valid, "unknown category should be invalid");
  });

  test("validateTransactionInput accepts a well-formed expense", function () {
    var s = freshState();
    var res = BuamMoney.validateTransactionInput({ amount: 120.5, type: "expense", categoryId: "exp-food", date: "2026-08-01" }, s.categories);
    assertTrue(res.valid, "well-formed expense should be valid: " + JSON.stringify(res.errors));
  });

  /* ---------------- amount storage (no float drift) ---------------- */

  test("toMinor/toBaht round-trip common decimal amounts without drift", function () {
    [0.1, 0.2, 0.3, 12.1, 99.99, 1234.56].forEach(function (baht) {
      var minor = BuamMoney.toMinor(baht);
      assertTrue(Number.isInteger(minor), baht + " -> minor must be an integer, got " + minor);
      assertClose(BuamMoney.toBaht(minor), baht, 1e-9, "round trip for " + baht);
    });
  });

  test("adding 0.1 + 0.2 baht in minor units equals exactly 0.3 baht (no float drift)", function () {
    var a = BuamMoney.toMinor(0.1), b = BuamMoney.toMinor(0.2);
    assertEqual(a + b, BuamMoney.toMinor(0.3));
  });

  /* ---------------- transaction CRUD ---------------- */

  test("addTransaction stores amount as integer minor units and rejects invalid input", function () {
    var s = freshState();
    var res = BuamMoney.addTransaction(s.transactions, s.categories, { amount: 45.5, type: "expense", categoryId: "exp-food", date: "2026-08-01", note: "lunch" });
    assertTrue(res.ok, "valid transaction should succeed");
    assertEqual(res.transaction.amount, 4550);
    assertEqual(s.transactions.length, 1);

    var bad = BuamMoney.addTransaction(s.transactions, s.categories, { amount: -1, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    assertTrue(!bad.ok, "negative amount should be rejected");
    assertEqual(s.transactions.length, 1, "rejected transaction must not be added");
  });

  test("updateTransaction and deleteTransaction mutate the array in place", function () {
    var s = freshState();
    var res = BuamMoney.addTransaction(s.transactions, s.categories, { amount: 100, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    var id = res.transaction.id;
    var upd = BuamMoney.updateTransaction(s.transactions, s.categories, id, { amount: 200, type: "expense", categoryId: "exp-transport", date: "2026-08-02" });
    assertTrue(upd.ok);
    assertEqual(s.transactions[0].amount, 20000);
    assertEqual(s.transactions[0].categoryId, "exp-transport");

    var del = BuamMoney.deleteTransaction(s.transactions, id);
    assertTrue(del.ok);
    assertEqual(s.transactions.length, 0);
  });

  test("queryTransactions filters by type, category, date range and search, and sorts", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 100, type: "expense", categoryId: "exp-food", date: "2026-08-01", note: "pad thai" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 200, type: "expense", categoryId: "exp-transport", date: "2026-08-05", note: "bts" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 300, type: "income", categoryId: "inc-allowance", date: "2026-08-10", note: "allowance" });

    assertEqual(BuamMoney.queryTransactions(s.transactions, { type: "expense" }).length, 2);
    assertEqual(BuamMoney.queryTransactions(s.transactions, { categoryId: "exp-food" }).length, 1);
    assertEqual(BuamMoney.queryTransactions(s.transactions, { from: "2026-08-05", to: "2026-08-31" }).length, 2);
    assertEqual(BuamMoney.queryTransactions(s.transactions, { search: "thai" }).length, 1);
    assertEqual(BuamMoney.queryTransactions(s.transactions, { search: "เดินทาง", categories: s.categories }).length, 1, "search should also match category name when categories are provided");

    var sorted = BuamMoney.queryTransactions(s.transactions, { sortBy: "date", sortDir: "asc" });
    assertEqual(sorted[0].date, "2026-08-01");
    assertEqual(sorted[2].date, "2026-08-10");
  });

  /* ---------------- categories ---------------- */

  test("deleteCategory archives when in use, hard-deletes when unused", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 10, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    var res1 = BuamMoney.deleteCategory(s.categories, s.transactions, "exp-food");
    assertTrue(res1.ok && res1.archived, "category in use should be archived, not removed");
    assertTrue(BuamMoney.findCategory(s.categories, "exp-food").archived);

    var res2 = BuamMoney.deleteCategory(s.categories, s.transactions, "exp-transport");
    assertTrue(res2.ok && !res2.archived, "unused category should be hard-deleted");
    assertNull(BuamMoney.findCategory(s.categories, "exp-transport"));
  });

  /* ---------------- budget usage ---------------- */

  test("calcGroupUsage: normal / near / over thresholds with correct status", function () {
    var s = freshState();
    var mKey = "2026-08";
    var budget = BuamMoney.getMonthlyBudget(s.monthlyBudgets, s.budgetGroups, s.settings, mKey);
    // Living budget = 9000 baht. Spend 5000 -> normal, 7500 -> near (83%), 9500 -> over.
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 5000, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    var usage = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    var living = usage.filter(function (g) { return g.groupId === "grp-living"; })[0];
    assertEqual(living.status, "normal");

    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 2500, type: "expense", categoryId: "exp-transport", date: "2026-08-02" });
    usage = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    living = usage.filter(function (g) { return g.groupId === "grp-living"; })[0];
    assertEqual(living.status, "near");

    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 2000, type: "expense", categoryId: "exp-other", date: "2026-08-03" });
    usage = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    living = usage.filter(function (g) { return g.groupId === "grp-living"; })[0];
    assertEqual(living.status, "over");
    assertTrue(living.remaining < 0, "remaining should go negative when over budget");
  });

  test("calcGroupUsage treats spending exactly the full budget as its own 'reached' status, not 'over'", function () {
    var s = freshState();
    var mKey = "2026-08";
    var budget = BuamMoney.getMonthlyBudget(s.monthlyBudgets, s.budgetGroups, s.settings, mKey);
    // Investment budget = 3000 baht — investing exactly 3000 hits the target, it doesn't exceed it.
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 3000, type: "investment", categoryId: "inv-etf", date: "2026-08-01" });
    var usage = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    var inv = usage.filter(function (g) { return g.isInvestmentGroup; })[0];
    assertEqual(inv.pct, 1);
    assertEqual(inv.status, "reached", "spending exactly the budget should be its own milestone status, not 'over'");
    assertEqual(inv.remaining, 0);

    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 1, type: "investment", categoryId: "inv-etf", date: "2026-08-02" });
    usage = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    inv = usage.filter(function (g) { return g.isInvestmentGroup; })[0];
    assertEqual(inv.status, "over", "spending even slightly more than the budget should read as 'over'");
  });

  test("STATUS_RANK orders normal < near < reached < over for worsening comparisons", function () {
    assertTrue(BuamMoney.STATUS_RANK.normal < BuamMoney.STATUS_RANK.near);
    assertTrue(BuamMoney.STATUS_RANK.near < BuamMoney.STATUS_RANK.reached);
    assertTrue(BuamMoney.STATUS_RANK.reached < BuamMoney.STATUS_RANK.over);
  });

  test("calcGroupUsage handles a zero budget group without dividing by zero", function () {
    var s = freshState();
    var mKey = "2026-08";
    var res = BuamMoney.updateBudgetGroup(s.budgetGroups, "grp-relationship", { monthlyAmount: 0 });
    assertTrue(res.ok);
    var budget = BuamMoney.getMonthlyBudget(s.monthlyBudgets, s.budgetGroups, s.settings, mKey);
    var usageEmpty = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    var rel = usageEmpty.filter(function (g) { return g.groupId === "grp-relationship"; })[0];
    assertEqual(rel.pct, null);
    assertEqual(rel.status, "normal", "zero budget with zero spend is not 'over'");

    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 50, type: "expense", categoryId: "exp-fun", date: "2026-08-01" });
    var usageSpent = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    rel = usageSpent.filter(function (g) { return g.groupId === "grp-relationship"; })[0];
    assertEqual(rel.status, "over", "any spend against a zero budget is 'over'");
  });

  test("investment-type transactions roll up into the Investment budget group regardless of investment category", function () {
    var s = freshState();
    var mKey = "2026-08";
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 1000, type: "investment", categoryId: "inv-etf", date: "2026-08-01", asset: "ETF" });
    var budget = BuamMoney.getMonthlyBudget(s.monthlyBudgets, s.budgetGroups, s.settings, mKey);
    var usage = BuamMoney.calcGroupUsage(s.transactions, s.categories, s.budgetGroups, budget, mKey);
    var inv = usage.filter(function (g) { return g.isInvestmentGroup; })[0];
    assertEqual(inv.spent, 100000);
  });

  /* ---------------- dashboard ---------------- */

  test("calcDashboard: no transactions in a month yields all-zero, null rates", function () {
    var dash = BuamMoney.calcDashboard([], "2026-08", null);
    assertEqual(dash.income, 0);
    assertEqual(dash.expense, 0);
    assertEqual(dash.investment, 0);
    assertEqual(dash.remaining, 0);
    assertNull(dash.savingsRate);
    assertNull(dash.investmentRate);
  });

  test("calcDashboard: example from the spec (14000 income, 8200 expense, 3000 investment)", function () {
    var s = freshState();
    var mKey = "2026-08";
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 14000, type: "income", categoryId: "inc-allowance", date: "2026-08-01" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 8200, type: "expense", categoryId: "exp-food", date: "2026-08-02" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 3000, type: "investment", categoryId: "inv-etf", date: "2026-08-03" });
    var dash = BuamMoney.calcDashboard(s.transactions, mKey, null);
    assertEqual(dash.income, 1400000);
    assertEqual(dash.expense, 820000);
    assertEqual(dash.investment, 300000);
    assertEqual(dash.remaining, 280000);
    assertClose(dash.investmentRate, 3000 / 14000, 1e-9);
  });

  test("calcDashboard: expense greater than income yields negative remaining and negative savings rate", function () {
    var s = freshState();
    var mKey = "2026-08";
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 1000, type: "income", categoryId: "inc-allowance", date: "2026-08-01" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 1500, type: "expense", categoryId: "exp-food", date: "2026-08-02" });
    var dash = BuamMoney.calcDashboard(s.transactions, mKey, null);
    assertTrue(dash.remaining < 0);
    assertTrue(dash.savingsRate < 0);
  });

  test("calcMonthComparison returns deltas, and null when no previous month data", function () {
    var s = freshState();
    var curr = BuamMoney.calcDashboard(s.transactions, "2026-08", null);
    assertNull(BuamMoney.calcMonthComparison(curr, null));

    var prevTx = [];
    BuamMoney.addTransaction(prevTx, s.categories, { amount: 1000, type: "expense", categoryId: "exp-food", date: "2026-07-01" });
    var prev = BuamMoney.calcDashboard(prevTx, "2026-07", null);
    var currTx = [];
    BuamMoney.addTransaction(currTx, s.categories, { amount: 1500, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    curr = BuamMoney.calcDashboard(currTx, "2026-08", null);
    var cmp = BuamMoney.calcMonthComparison(curr, prev);
    assertClose(cmp.expenseDelta, 0.5, 1e-9, "expense grew 50%");
  });

  /* ---------------- monthly aggregation ---------------- */

  test("aggregateByPeriod buckets by month across a year and sums per type", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 100, type: "expense", categoryId: "exp-food", date: "2026-01-15" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 50, type: "expense", categoryId: "exp-food", date: "2026-01-20" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 200, type: "income", categoryId: "inc-allowance", date: "2026-02-01" });
    var monthly = BuamMoney.aggregateByPeriod(s.transactions, "month", null, null);
    assertEqual(monthly.length, 2);
    assertEqual(monthly[0].key, "2026-01");
    assertEqual(monthly[0].expense, 15000);
    assertEqual(monthly[1].key, "2026-02");
    assertEqual(monthly[1].income, 20000);
  });

  test("categoryBreakdown computes shares that sum to 1 and sorts descending", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 300, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 100, type: "expense", categoryId: "exp-transport", date: "2026-08-02" });
    var breakdown = BuamMoney.categoryBreakdown(s.transactions, s.categories, "expense", null, null);
    assertEqual(breakdown[0].categoryId, "exp-food", "largest category first");
    assertClose(breakdown[0].pct + breakdown[1].pct, 1, 1e-9);
  });

  /* ---------------- investment totals ---------------- */

  test("investment totals: cumulative and per-month sums", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 1000, type: "investment", categoryId: "inv-etf", date: "2026-07-01" });
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 3000, type: "investment", categoryId: "inv-etf", date: "2026-08-13" });
    var all = BuamMoney.queryTransactions(s.transactions, { type: "investment" });
    var cumulative = all.reduce(function (sum, t) { return sum + t.amount; }, 0);
    assertEqual(cumulative, 400000);
    var augDash = BuamMoney.calcDashboard(s.transactions, "2026-08", null);
    assertEqual(augDash.investment, 300000);
  });

  /* ---------------- savings rate edge cases ---------------- */

  test("savings rate is null (not divide-by-zero) for a month with zero income", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 500, type: "expense", categoryId: "exp-food", date: "2026-08-01" });
    var dash = BuamMoney.calcDashboard(s.transactions, "2026-08", null);
    assertNull(dash.savingsRate);
    assertNull(dash.investmentRate);
  });

  /* ---------------- recurring income ---------------- */

  test("runRecurringCatchUp generates monthly occurrences up to today and is idempotent on re-run", function () {
    var s = freshState();
    var rec = BuamMoney.addRecurring(s.recurring, s.categories, { amount: 500, categoryId: "inc-allowance", frequency: "monthly", startDate: "2026-05-01" });
    assertTrue(rec.ok);
    var created1 = BuamMoney.runRecurringCatchUp(s.recurring, s.transactions, s.categories, "2026-08-13");
    assertEqual(created1.length, 4, "May, Jun, Jul, Aug occurrences");
    assertEqual(s.transactions.length, 4);

    var created2 = BuamMoney.runRecurringCatchUp(s.recurring, s.transactions, s.categories, "2026-08-13");
    assertEqual(created2.length, 0, "re-running the same day must not duplicate");
    assertEqual(s.transactions.length, 4);
  });

  test("runRecurringCatchUp respects endDate and weekly/biweekly cadence", function () {
    var s = freshState();
    BuamMoney.addRecurring(s.recurring, s.categories, { amount: 100, categoryId: "inc-allowance", frequency: "weekly", startDate: "2026-08-01", endDate: "2026-08-15" });
    var created = BuamMoney.runRecurringCatchUp(s.recurring, s.transactions, s.categories, "2026-09-01");
    // weekly from Aug 1: Aug1, Aug8, Aug15 (Aug22 exceeds endDate)
    assertEqual(created.length, 3);

    var s2 = freshState();
    BuamMoney.addRecurring(s2.recurring, s2.categories, { amount: 100, categoryId: "inc-allowance", frequency: "biweekly", startDate: "2026-08-01" });
    var created2 = BuamMoney.runRecurringCatchUp(s2.recurring, s2.transactions, s2.categories, "2026-08-29");
    // Aug1, Aug15, Aug29
    assertEqual(created2.length, 3);
  });

  test("validateRecurringInput rejects an end date before the start date and a non-income category", function () {
    var s = freshState();
    var bad = BuamMoney.validateRecurringInput({ amount: 100, categoryId: "inc-allowance", frequency: "monthly", startDate: "2026-08-10", endDate: "2026-08-01" }, s.categories);
    assertTrue(!bad.valid);
    var badCat = BuamMoney.validateRecurringInput({ amount: 100, categoryId: "exp-food", frequency: "monthly", startDate: "2026-08-01" }, s.categories);
    assertTrue(!badCat.valid, "recurring income must use an income category");
  });

  /* ---------------- import / export ---------------- */

  test("exportJSON then importJSON round-trips transactions exactly", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 250, type: "expense", categoryId: "exp-food", date: "2026-08-01", note: "test" });
    var json = BuamMoney.exportJSON(s);
    var imported = BuamMoney.importJSON(json);
    assertTrue(imported.ok);
    assertEqual(imported.state.transactions.length, 1);
    assertEqual(imported.state.transactions[0].amount, 25000);
  });

  test("importJSON rejects malformed / incomplete payloads instead of corrupting state", function () {
    assertTrue(!BuamMoney.importJSON("not json").ok);
    assertTrue(!BuamMoney.importJSON(JSON.stringify({ transactions: [] })).ok, "missing settings/categories/budgetGroups");
    assertTrue(!BuamMoney.importJSON(JSON.stringify({
      settings: { monthlyIncome: 100 }, budgetGroups: [], categories: { income: [], expense: [], investment: [] },
      transactions: [{ amount: NaN, type: "expense", date: "2026-08-01" }]
    })).ok, "NaN amount inside a transaction must fail validation");
  });

  test("exportTransactionsCSV produces a header row plus one row per transaction", function () {
    var s = freshState();
    BuamMoney.addTransaction(s.transactions, s.categories, { amount: 99.99, type: "expense", categoryId: "exp-food", date: "2026-08-01", note: "a, b" });
    var csv = BuamMoney.exportTransactionsCSV(s.transactions, s.categories);
    var lines = csv.split("\n");
    assertEqual(lines.length, 2);
    assertTrue(lines[1].indexOf("99.99") !== -1);
  });

  /* ---------------- large volume sanity ---------------- */

  test("queryTransactions and calcDashboard stay correct with a large number of transactions", function () {
    var s = freshState();
    for (var i = 0; i < 2000; i++) {
      var day = String((i % 28) + 1).padStart(2, "0");
      BuamMoney.addTransaction(s.transactions, s.categories, { amount: 10, type: "expense", categoryId: "exp-food", date: "2026-08-" + day });
    }
    assertEqual(s.transactions.length, 2000);
    var dash = BuamMoney.calcDashboard(s.transactions, "2026-08", null);
    assertEqual(dash.expense, 2000 * 1000);
  });

  /* ---------------- report ---------------- */

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.filter(function (r) { return !r.ok; }).length;
  var summaryLines = results.map(function (r) {
    return (r.ok ? "PASS" : "FAIL") + " — " + r.name + (r.ok ? "" : "\n       " + r.error);
  });
  var summary = summaryLines.join("\n") + "\n\n" + passed + " passed, " + failed + " failed, " + results.length + " total";

  if (typeof module !== "undefined" && typeof process !== "undefined" && !process.browser) {
    console.log(summary);
    process.exitCode = failed > 0 ? 1 : 0;
  } else {
    window.__buamMoneyTestResults = { passed: passed, failed: failed, total: results.length, results: results, summary: summary };
    if (typeof document !== "undefined") {
      document.addEventListener("DOMContentLoaded", function () { render(); });
      if (document.readyState !== "loading") render();
    }
    function render() {
      var pre = document.getElementById("results");
      if (pre) pre.textContent = summary;
      console.log(summary);
    }
  }
})();
