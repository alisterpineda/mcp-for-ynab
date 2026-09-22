import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentMonth, dateRange, historyStart, historyWindow, MAX_MONTHS, monthWindow } from "../src/tools/dates.js";
import { ToolError } from "../src/tools/envelope.js";

describe("dateRange", () => {
  it("takes full dates on both ends and keeps them inclusive", () => {
    assert.deepEqual(dateRange("2026-03-03", "2026-03-17"), { from: "2026-03-03", to: "2026-03-17" });
  });

  it("expands a month start to its first day and a month end to its last", () => {
    assert.deepEqual(dateRange("2026-03", "2026-03"), { from: "2026-03-01", to: "2026-03-31" });
    assert.deepEqual(dateRange("2026-04", "2026-04"), { from: "2026-04-01", to: "2026-04-30" });
  });

  it("knows February's length in a leap year and outside one", () => {
    assert.equal(dateRange("2024-02", "2024-02").to, "2024-02-29");
    assert.equal(dateRange("2026-02", "2026-02").to, "2026-02-28");
  });

  it("mixes the two forms on either end", () => {
    assert.deepEqual(dateRange("2026-03", "2026-05-09"), { from: "2026-03-01", to: "2026-05-09" });
    assert.deepEqual(dateRange("2026-03-09", "2026-05"), { from: "2026-03-09", to: "2026-05-31" });
  });

  it("defaults the end to today and the start to the first of today's month", () => {
    assert.deepEqual(dateRange(undefined, undefined, new Date(2026, 8, 22)), { from: "2026-09-01", to: "2026-09-22" });
  });

  it("reads today as the machine's local date, not UTC", () => {
    // 23:30 local on the last day of the month: a UTC reading would roll into the next month.
    assert.deepEqual(dateRange(undefined, undefined, new Date(2026, 6, 31, 23, 30)), { from: "2026-07-01", to: "2026-07-31" });
  });

  it("defaults only the end when a start was given", () => {
    assert.deepEqual(dateRange("2026-05-04", undefined, new Date(2026, 8, 22)), { from: "2026-05-04", to: "2026-09-22" });
  });

  it("refuses a start after the end", () => {
    assert.throws(() => dateRange("2026-05-04", "2026-05-03"), (error: Error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /2026-05-04/);
      assert.match(error.message, /2026-05-03/);
      return true;
    });
  });

  it("refuses a value that is neither form, naming what it accepts", () => {
    for (const bad of ["march", "2026", "26-05-04", "2026-5-4", "2026-05-04T00:00:00"]) {
      assert.throws(() => dateRange(bad, "2026-06-01"), (error: Error) => {
        assert.ok(error instanceof ToolError, bad);
        assert.match(error.message, /YYYY-MM-DD/, bad);
        assert.match(error.message, /YYYY-MM/, bad);
        return true;
      });
    }
  });

  it("refuses an impossible month or day", () => {
    for (const bad of ["2026-13", "2026-00", "2026-02-30", "2026-04-31", "2026-01-00"]) {
      assert.throws(() => dateRange(bad, undefined), ToolError, bad);
    }
  });
});

describe("monthWindow", () => {
  it("defaults to the six months ending at the current one", () => {
    assert.deepEqual(monthWindow(undefined, undefined, undefined, new Date(2026, 8, 22)), [
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  it("counts a requested number of months back across a year boundary", () => {
    assert.deepEqual(monthWindow(3, undefined, undefined, new Date(2026, 0, 15)), ["2025-11", "2025-12", "2026-01"]);
  });

  it("lets an explicit start and end win over the month count", () => {
    assert.deepEqual(monthWindow(6, "2026-02", "2026-04", new Date(2026, 8, 22)), ["2026-02", "2026-03", "2026-04"]);
  });

  it("counts back from an explicit end when only the end is given", () => {
    assert.deepEqual(monthWindow(2, undefined, "2026-04", new Date(2026, 8, 22)), ["2026-03", "2026-04"]);
  });

  it("runs an explicit start up to the current month when only the start is given", () => {
    assert.deepEqual(monthWindow(undefined, "2026-07", undefined, new Date(2026, 8, 22)), ["2026-07", "2026-08", "2026-09"]);
  });

  it("accepts a full date at either end and truncates it to its month", () => {
    assert.deepEqual(monthWindow(undefined, "2026-07-15", "2026-08-03", new Date(2026, 8, 22)), ["2026-07", "2026-08"]);
  });

  it("refuses a start after the end and an unreadable month", () => {
    assert.throws(() => monthWindow(undefined, "2026-05", "2026-04"), ToolError);
    assert.throws(() => monthWindow(undefined, "May", undefined), ToolError);
  });

  it("refuses a window longer than one report covers, however it is asked for", () => {
    assert.equal(monthWindow(MAX_MONTHS, undefined, "2026-09").length, MAX_MONTHS);
    assert.throws(() => monthWindow(MAX_MONTHS + 1, undefined, "2026-09"), /at most 120/);
    assert.throws(() => monthWindow(3_000_000, undefined, "2026-09"), /at most 120/);
    assert.throws(() => monthWindow(undefined, "0001-01", "9999-12"), /at most 120/);
  });
});

describe("currentMonth", () => {
  it("is the machine's local month as YYYY-MM", () => {
    assert.equal(currentMonth(new Date(2026, 8, 22)), "2026-09");
    assert.equal(currentMonth(new Date(2026, 11, 31, 23, 59)), "2026-12");
  });
});

describe("historyStart", () => {
  it("is the budget's first month as YYYY-MM", () => {
    assert.equal(historyStart("2026-07-01", "2026-07-03"), "2026-07");
  });

  it("reaches back to a transaction dated before the first budget month", () => {
    assert.equal(historyStart("2026-07-01", "2026-05-28"), "2026-05");
  });

  it("uses whichever of the two it has, and is null with neither", () => {
    assert.equal(historyStart(null, "2026-05-28"), "2026-05");
    assert.equal(historyStart("2026-07-01", null), "2026-07");
    assert.equal(historyStart(null, null), null);
  });
});

describe("historyWindow", () => {
  const today = new Date(2026, 8, 22);

  it("keeps a window inside the history whole, flagging the current month partial", () => {
    assert.deepEqual(historyWindow(["2026-07", "2026-08", "2026-09"], "2026-01", today), {
      months: ["2026-07", "2026-08", "2026-09"],
      from: "2026-07-01",
      to: "2026-09-30",
      cut: false,
      partialMonth: "2026-09",
    });
  });

  it("has no partial month when the window ends before the current one", () => {
    const window = historyWindow(["2026-06", "2026-07"], "2026-01", today);
    assert.equal(window.partialMonth, null);
    assert.equal(window.to, "2026-07-31");
  });

  it("cuts a window reaching back before the history at its first month, and says so", () => {
    const window = historyWindow(["2026-05", "2026-06", "2026-07"], "2026-06", today);
    assert.deepEqual(window.months, ["2026-06", "2026-07"]);
    assert.equal(window.from, "2026-06-01");
    assert.equal(window.cut, true);
  });

  it("keeps the whole window for a budget with no history to cut at", () => {
    const window = historyWindow(["2026-05", "2026-06"], null, today);
    assert.deepEqual(window.months, ["2026-05", "2026-06"]);
    assert.equal(window.cut, false);
  });

  it("refuses a window past the current month", () => {
    assert.throws(() => historyWindow(["2026-09", "2026-10"], null, today), (error: Error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /ends at 2026-10, after the current month 2026-09/);
      return true;
    });
  });

  it("refuses a window wholly before the history, naming where it starts", () => {
    assert.throws(() => historyWindow(["2026-01", "2026-02"], "2026-06", today), (error: Error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /history starts at 2026-06/);
      return true;
    });
  });
});
