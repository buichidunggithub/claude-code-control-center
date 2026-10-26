import { describe, expect, it } from "vitest";
import {
  MAX_RANGE_DAYS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  parseDayQuery,
  parseFindingsQuery,
  parseNoParams,
  parseRecommendationsQuery,
  parsePagedSidechainQuery,
  parseSidechainQuery,
} from "@/core/analysis";

const q = (s: string) => new URLSearchParams(s);

describe("recommendations filters", () => {
  it("accepts known categories and priorities, and treats empty values as absent", () => {
    expect(parseRecommendationsQuery(q(""))).toEqual({ ok: true, value: { category: null, priority: null, limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
    expect(parseRecommendationsQuery(q("category=data-quality&priority=medium&limit=5&offset=2"))).toEqual({ ok: true, value: { category: "data-quality", priority: "medium", limit: 5, offset: 2 } });
    expect(parseRecommendationsQuery(q("category=&priority="))).toMatchObject({ ok: true, value: { category: null, priority: null } });
  });

  it.each([
    ["category=savings", "category"],
    ["category=Data-Quality", "category"],
    ["category=%20", "category"],
    ["category=usage-insight&category=data-quality", "category"],
    ["priority=urgent", "priority"],
    ["priority=high&priority=", "priority"],
    ["priority=constructor", "priority"],
    ["limit=0", "limit"],
    ["offset=-1", "offset"],
    ["severity=high", "severity"],
  ])("rejects %s naming only the parameter", (query, parameter) => {
    expect(parseRecommendationsQuery(q(query))).toEqual({ ok: false, parameter });
  });
});

describe("query parameter validation", () => {
  it("applies bounded defaults", () => {
    expect(parsePagedSidechainQuery(q(""))).toEqual({ ok: true, value: { sidechain: "include", limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
    expect(parseFindingsQuery(q(""))).toEqual({ ok: true, value: { severity: null, ruleId: null, limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
  });

  it.each([
    ["limit=0", "limit"],
    [`limit=${PAGE_LIMIT_MAX + 1}`, "limit"],
    ["limit=-1", "limit"],
    ["limit=1.5", "limit"],
    ["limit=abc", "limit"],
    ["limit=1&limit=2", "limit"],
    ["offset=-1", "offset"],
    ["offset=100001", "offset"],
    ["offset=1e3", "offset"],
    ["sidechain=maybe", "sidechain"],
    ["sidechain=include&sidechain=exclude", "sidechain"],
    ["page=2", "page"],
  ])("rejects %s naming only the parameter", (query, parameter) => {
    expect(parsePagedSidechainQuery(q(query))).toEqual({ ok: false, parameter });
  });

  it("accepts the documented limits", () => {
    expect(parsePagedSidechainQuery(q(`limit=${PAGE_LIMIT_MAX}&offset=100000&sidechain=exclude`))).toEqual({ ok: true, value: { sidechain: "exclude", limit: PAGE_LIMIT_MAX, offset: 100000 } });
  });

  it("rejects any parameter on endpoints that take none, and unknown parameters elsewhere", () => {
    expect(parseNoParams(q("sidechain=include"))).toEqual({ ok: false, parameter: "sidechain" });
    expect(parseSidechainQuery(q("limit=5"))).toEqual({ ok: false, parameter: "limit" });
    expect(parseNoParams(q(""))).toEqual({ ok: true, value: {} });
  });

  it("never echoes an odd parameter name", () => {
    const result = parseNoParams(q(`${encodeURIComponent("CANARY_PATH_9c1d/../x")}=1`));
    expect(result).toEqual({ ok: false, parameter: "unknown" });
  });

  describe("empty values from browser forms", () => {
    it("treats an explicitly empty optional value as absent", () => {
      expect(parseFindingsQuery(q("severity=&ruleId="))).toEqual({ ok: true, value: { severity: null, ruleId: null, limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
      expect(parseDayQuery(q("from=&to="))).toEqual({ ok: true, value: { sidechain: "include", limit: PAGE_LIMIT_DEFAULT, offset: 0, from: null, to: null } });
      expect(parsePagedSidechainQuery(q("sidechain=&limit=&offset="))).toEqual({ ok: true, value: { sidechain: "include", limit: PAGE_LIMIT_DEFAULT, offset: 0 } });
      expect(parseDayQuery(q("from=2026-01-01&to="))).toMatchObject({ ok: true, value: { from: "2026-01-01", to: null } });
    });

    it.each([
      ["severity=%20", "severity"],
      ["severity=&severity=high", "severity"],
      ["severity=high&severity=", "severity"],
      ["ruleId=%20", "ruleId"],
      ["ruleId=CFG-SIZE-001&ruleId=", "ruleId"],
      ["limit=%20", "limit"],
      ["limit=0&limit=", "limit"],
    ])("still rejects %s", (query, parameter) => {
      const result = parameter === "limit" ? parsePagedSidechainQuery(q(query)) : parseFindingsQuery(q(query));
      expect(result).toEqual({ ok: false, parameter });
    });

    it("still rejects malformed non-empty dates and unknown parameters alongside empty ones", () => {
      expect(parseDayQuery(q("from=&to=2026-02-30"))).toEqual({ ok: false, parameter: "to" });
      expect(parseDayQuery(q("from=&bogus="))).toEqual({ ok: false, parameter: "bogus" });
      expect(parseDayQuery(q("from=&from="))).toEqual({ ok: false, parameter: "from" });
    });
  });

  describe("day ranges", () => {
    it("accepts valid UTC days and open ends", () => {
      expect(parseDayQuery(q("from=2026-01-01&to=2026-01-31"))).toMatchObject({ ok: true, value: { from: "2026-01-01", to: "2026-01-31" } });
      expect(parseDayQuery(q("from=2026-01-01"))).toMatchObject({ ok: true, value: { from: "2026-01-01", to: null } });
    });

    it.each([
      ["from=2026-02-30", "from"],
      ["from=2026-13-01", "from"],
      ["from=20260101", "from"],
      ["from=2026-1-1", "from"],
      ["to=yesterday", "to"],
      ["from=2026-01-01&from=2026-01-02", "from"],
      ["from=2026-02-01&to=2026-01-01", "to"],
    ])("rejects %s", (query, parameter) => {
      expect(parseDayQuery(q(query))).toEqual({ ok: false, parameter });
    });

    it("bounds the range to one year", () => {
      expect(parseDayQuery(q("from=2026-01-01&to=2026-12-31"))).toMatchObject({ ok: true });
      expect(MAX_RANGE_DAYS).toBe(366);
      expect(parseDayQuery(q("from=2024-01-01&to=2024-12-31"))).toMatchObject({ ok: true });
      expect(parseDayQuery(q("from=2024-01-01&to=2025-01-01"))).toEqual({ ok: false, parameter: "to" });
    });
  });

  describe("findings filters", () => {
    it("accepts known severities and rule ids only", () => {
      expect(parseFindingsQuery(q("severity=high&ruleId=CFG-SIZE-001"))).toMatchObject({ ok: true, value: { severity: "high", ruleId: "CFG-SIZE-001" } });
      expect(parseFindingsQuery(q("severity=critical"))).toEqual({ ok: false, parameter: "severity" });
      expect(parseFindingsQuery(q("ruleId=CFG-NOPE-999"))).toEqual({ ok: false, parameter: "ruleId" });
      expect(parseFindingsQuery(q("ruleId=constructor"))).toEqual({ ok: false, parameter: "ruleId" });
      expect(parseFindingsQuery(q("ruleId=%27%3B%20DROP%20TABLE%20x"))).toEqual({ ok: false, parameter: "ruleId" });
    });
  });
});
