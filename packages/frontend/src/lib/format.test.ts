import { describe, it, expect } from "vitest";
import { fmtBps, fmtGb, fmtMoney, fmtMusd, fmtUsdNumber } from "./format";
import { csvCell, toCsv } from "./csv";

describe("format", () => {
  it("formats USD with 2–6 decimals", () => {
    expect(fmtUsdNumber(1234.5)).toBe("$1,234.50");
    expect(fmtUsdNumber(0)).toBe("$0.00");
    expect(fmtUsdNumber(0.25)).toBe("$0.2500");
    expect(fmtUsdNumber(0.000123)).toBe("$0.000123");
    expect(fmtMoney({ musd: "1500000", usd: "1.500000" })).toBe("$1.50");
    expect(fmtMusd("3000000")).toBe("$3.00");
    expect(fmtMoney(null)).toBe("—");
  });
  it("formats GB and bps", () => {
    expect(fmtGb("2.000000")).toBe("2.00 GB");
    expect(fmtGb("0.004")).toBe("0.0040 GB");
    expect(fmtGb(1500)).toBe("1.5 TB");
    expect(fmtBps(3000)).toBe("30.00%");
  });
});

describe("csv", () => {
  it("quotes and neutralises formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-1.5")).toBe("-1.5");
    expect(toCsv(["a"], [[1]])).toBe("a\r\n1\r\n");
  });
});
