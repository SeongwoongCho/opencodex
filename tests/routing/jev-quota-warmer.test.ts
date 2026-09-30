import { afterEach, describe, expect, test } from "bun:test";
import {
  configNeedsJevQuotaWarmth,
  isJevQuotaWarmerRunning,
  jevQuotaWarmerRefreshCountForTests,
  resetJevQuotaWarmerForTests,
  runJevQuotaWarmerTickForTests,
  startJevQuotaWarmer,
  stopJevQuotaWarmer,
} from "../../src/combos/jev-quota-warmer";
import { firstLoadTimePathTo, resolvedImportEdges } from "../helpers/import-graph";

afterEach(() => resetJevQuotaWarmerForTests());

const levelCombo = { strategy: "jev", decisionMode: "level", decisionQuotaSignals: true, targets: [] };

describe("JEV quota warmer", () => {
  test("only a quota-aware JEV level-mode combo needs warm quota rows", () => {
    expect(configNeedsJevQuotaWarmth({ combos: { auto: levelCombo } })).toBeTrue();
    for (const combo of [
      { ...levelCombo, decisionQuotaSignals: false },
      { ...levelCombo, decisionMode: undefined },
      { ...levelCombo, decisionMode: "route" },
      { ...levelCombo, strategy: "failover" },
      null,
    ]) {
      expect(configNeedsJevQuotaWarmth({ combos: { auto: combo } })).toBeFalse();
    }
    expect(configNeedsJevQuotaWarmth({})).toBeFalse();
    expect(configNeedsJevQuotaWarmth(undefined)).toBeFalse();
  });

  test("a tick refreshes only while such a combo exists, and joins a refresh in flight", async () => {
    const refreshed: unknown[] = [];
    let config: { combos?: Record<string, unknown> } = { combos: { plain: { strategy: "jev" } } };
    let release: () => void = () => {};
    const deps = {
      loadConfig: () => config,
      refresh: (value: unknown) => {
        refreshed.push(value);
        return new Promise<void>(resolve => { release = resolve; });
      },
    };
    await runJevQuotaWarmerTickForTests(deps);
    expect(refreshed).toEqual([]);

    config = { combos: { auto: levelCombo } };
    const first = runJevQuotaWarmerTickForTests(deps);
    const second = runJevQuotaWarmerTickForTests(deps);
    expect(second).toBe(first);
    await Bun.sleep(0);
    release();
    await first;
    expect(refreshed).toEqual([config]);
    expect(jevQuotaWarmerRefreshCountForTests()).toBe(1);
  });

  test("a failed refresh or config read never escapes the tick", async () => {
    await runJevQuotaWarmerTickForTests({
      loadConfig: () => ({ combos: { auto: levelCombo } }),
      refresh: async () => { throw new Error("quota endpoint down"); },
    });
    await runJevQuotaWarmerTickForTests({
      loadConfig: () => { throw new Error("config unreadable"); },
      refresh: async () => undefined,
    });
    expect(jevQuotaWarmerRefreshCountForTests()).toBe(1);
  });

  test("start is idempotent and stop cancels the pending tick", () => {
    expect(isJevQuotaWarmerRunning()).toBeFalse();
    startJevQuotaWarmer(60_000);
    startJevQuotaWarmer(60_000);
    expect(isJevQuotaWarmerRunning()).toBeTrue();
    stopJevQuotaWarmer();
    expect(isJevQuotaWarmerRunning()).toBeFalse();
  });

  test("costs the server one import-free module and stays off the request path", () => {
    expect(resolvedImportEdges("src/combos/jev-quota-warmer.ts").filter(edge => !edge.dynamic)).toEqual([]);
    const isWarmer = (path: string) => path.endsWith("/src/combos/jev-quota-warmer.ts");
    // The composition root does reach it, which proves the walker sees the edge at all.
    expect(firstLoadTimePathTo("src/server/index.ts", isWarmer)?.join(" -> ")).toContain("src/server/background-lifecycle.ts");
    for (const core of ["src/router.ts", "src/server/lifecycle.ts", "src/server/responses/core.ts"]) {
      expect(firstLoadTimePathTo(core, isWarmer)).toBeNull();
    }
  });
});
