import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ConfigPage from "@/app/config/page";
import UsagePage from "@/app/usage/page";
import { DATABASE_PATH_ENV } from "@/server/analysis";
import { populatedDatabase } from "./analysis-helpers";
import { submitForm, toRaw, type SearchParams } from "./form-helpers";
import { registerTempStoreCleanup } from "./store-helpers";

registerTempStoreCleanup();

const html = (element: ReactElement) => renderToStaticMarkup(element);
const usage = async (query: SearchParams = {}) => html(await UsagePage({ searchParams: Promise.resolve(query) }));
const config = async (query: SearchParams = {}) => html(await ConfigPage({ searchParams: Promise.resolve(query) }));

const saved = process.env[DATABASE_PATH_ENV];
beforeEach(async () => {
  process.env[DATABASE_PATH_ENV] = (await populatedDatabase()).dbPath;
});
afterEach(() => {
  if (saved === undefined) delete process.env[DATABASE_PATH_ENV];
  else process.env[DATABASE_PATH_ENV] = saved;
});

describe("usage filter form", () => {
  it("sends blank dates like a browser, and the resulting page is a normal, usable page", async () => {
    const params = submitForm(await usage(), "/usage");
    expect(Object.fromEntries(params)).toEqual({ from: "", to: "" });

    const page = await usage(toRaw(params));
    expect(page).not.toContain("filter is not valid");
    expect(page).toContain("Settled tokens by UTC day");
    expect(page).toContain("Settled tokens by model");
  });

  it("keeps the sidechain choice in the form and applies a real range", async () => {
    const excluded = await usage({ sidechain: "exclude" });
    expect(Object.fromEntries(submitForm(excluded, "/usage"))).toEqual({ sidechain: "exclude", from: "", to: "" });

    const ranged = await usage(toRaw(submitForm(await usage(), "/usage", { from: "2026-01-10", to: "2026-01-10" })));
    expect(ranged).not.toContain("filter is not valid");
    const dayTable = ranged.slice(ranged.indexOf("By day (UTC)"), ranged.indexOf("Sessions"));
    expect(dayTable).toContain("2026-01-10");
    expect(dayTable).not.toContain("2026-02-01");
    expect(dayTable).not.toContain("2026-01-11");
  });

  it("lists days newest first and says so, with the page size", async () => {
    const page = await usage();
    expect(page.indexOf("2026-02-01")).toBeGreaterThan(-1);
    expect(page.indexOf("2026-02-01")).toBeLessThan(page.indexOf("2026-01-11"));
    expect(page.indexOf("2026-01-11")).toBeLessThan(page.indexOf("2026-01-10"));
    expect(page).toContain("Newest day first, 50 days per page.");
  });

  it("does not trap the user on an invalid filter: alert plus the unfiltered dashboard and a working form", async () => {
    for (const bad of [{ from: "2026-02-30" }, { sidechain: "maybe" }, { limit: "0" }, { to: ["2026-01-01", "2026-01-02"] }]) {
      const page = await usage(bad);
      expect(page).toContain('role="alert"');
      expect(page).toContain("filter is not valid");
      expect(page).toContain("Settled tokens by model");
      expect(page).toContain("Settled tokens by UTC day");
      expect(page).toContain('aria-label="Sections"');
      expect(Object.fromEntries(submitForm(page, "/usage"))).toEqual({ from: "", to: "" });
    }
  });

  it("states the page size and order of models and sessions, never implying a top-N", async () => {
    const page = await usage();
    expect(page).toMatch(/Showing all \d+ models, alphabetical by model name\./);
    expect(page).toMatch(/Showing all \d+ sessions, ordered by opaque id, not by usage; this is not a top-N/);
  });
});

describe("configuration filter form", () => {
  it("sends the 'All' options as empty values, and the resulting page shows unfiltered findings", async () => {
    const initial = await config();
    const params = submitForm(initial, "/config");
    expect(Object.fromEntries(params)).toEqual({ severity: "", ruleId: "" });

    const page = await config(toRaw(params));
    expect(page).not.toContain("filter is not valid");
    expect(page).toContain("medium severity");
    expect(page).toContain("info severity");
    expect(page).toContain("CFG-ACT-001");
  });

  it("applies a real severity or rule selection", async () => {
    const medium = await config(toRaw(submitForm(await config(), "/config", { severity: "medium" })));
    expect(medium).toContain("medium severity");
    expect(medium).not.toContain("info severity");

    const rule = await config(toRaw(submitForm(await config(), "/config", { ruleId: "CFG-ACT-001" })));
    expect(rule).toContain("CFG-ACT-001");
    expect(rule).not.toContain("CFG-IMP-001 ·");
  });

  it("falls back to unfiltered findings with an alert on an invalid filter", async () => {
    const page = await config({ severity: "urgent" });
    expect(page).toContain("filter is not valid");
    expect(page).toContain("Audit findings");
    expect(page).toContain("medium severity");
  });
});

describe("form helper sanity", () => {
  it("the helper itself would catch a form that sent an invalid value", async () => {
    const params = submitForm(await usage(), "/usage", { from: "yesterday" });
    expect(await usage(toRaw(params))).toContain("filter is not valid");
  });
});
