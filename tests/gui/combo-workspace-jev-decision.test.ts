import { describe, expect, test } from "bun:test";
import {
  JEV_DECISION_TIMEOUT_MAX_MS as SERVER_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS as SERVER_TIMEOUT_MIN_MS,
} from "../../src/combos/types";
import {
  type ComboItem,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
  draftEquals,
  jevAutoDraft,
  jevDecisionServiceOptions,
  jevDecisionSummary,
  parseComboList,
  toPutBody,
  validateComboDraft,
  withComboStrategy,
} from "../../gui/src/combo-workspace-data";
import {
  JEV_AUTO_CREATE_HASH,
  canCreateJevAutoFrom,
  jevAutoCreateDecisionProvider,
  jevAutoCreateHash,
  resolveAppHashChange,
} from "../../gui/src/app-routing";

const providers = [
  { name: "a", adapter: "openai-chat", baseUrl: "https://a.example/v1" },
  { name: "jev", adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone" },
  { name: "tev-local", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone" },
  { name: "mytev", adapter: "jev-decision", baseUrl: "https://local.example/v1/systemone" },
];

function parseOne(row: Record<string, unknown>): ComboItem {
  return parseComboList({ combos: [{ id: "tev-auto", targets: [{ provider: "a", model: "m1" }], ...row }] })[0]!;
}

describe("JEV decision service in the combo workspace", () => {
  test("GUI timeout bounds mirror the server constants", () => {
    expect(JEV_DECISION_TIMEOUT_MIN_MS).toBe(SERVER_TIMEOUT_MIN_MS);
    expect(JEV_DECISION_TIMEOUT_MAX_MS).toBe(SERVER_TIMEOUT_MAX_MS);
  });

  test("parse and PUT round-trip decisionProvider and decisionTimeoutMs", () => {
    const parsed = parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 });
    expect(parsed.decisionProvider).toBe("mytev");
    expect(parsed.decisionTimeoutMs).toBe(30000);
    const body = toPutBody(parsed).combo;
    expect(body.decisionProvider).toBe("mytev");
    expect(body.decisionTimeoutMs).toBe(30000);
    expect(draftEquals(parsed, parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 })))
      .toBe(true);
  });

  test("an unset JEV decision service is sent as explicit null so a save can clear it", () => {
    const parsed = parseOne({ strategy: "jev" });
    expect(parsed.decisionProvider ?? null).toBeNull();
    expect(parsed.decisionTimeoutMs ?? null).toBeNull();
    const body = toPutBody(parsed).combo;
    expect(Object.hasOwn(body, "decisionProvider")).toBe(true);
    expect(body.decisionProvider).toBeNull();
    expect(body.decisionTimeoutMs).toBeNull();

    // The canonical id is the default, never a stored value.
    expect(Object.hasOwn(parseOne({ strategy: "jev", decisionProvider: "jev" }), "decisionProvider")).toBe(false);
    expect(toPutBody({ ...parsed, decisionProvider: " jev " }).combo.decisionProvider).toBeNull();
  });

  test("editing either field marks the draft dirty and clearing restores it", () => {
    const baseline = parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 });
    expect(draftEquals(baseline, { ...baseline, decisionProvider: null })).toBe(false);
    expect(draftEquals(baseline, { ...baseline, decisionTimeoutMs: 4000 })).toBe(false);
    const cleared = { ...baseline, decisionProvider: null, decisionTimeoutMs: null };
    expect(toPutBody(cleared).combo).toMatchObject({ decisionProvider: null, decisionTimeoutMs: null });
    // Omitted and null both mean "default", so a combo created before these fields stays clean.
    const legacy: ComboItem = { ...cleared };
    delete legacy.decisionProvider;
    delete legacy.decisionTimeoutMs;
    expect(draftEquals(legacy, cleared)).toBe(true);
  });

  test("switching away from jev clears both fields in the draft and the payload", () => {
    const jev = parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 });
    const failover = withComboStrategy(jev, "failover");
    expect(failover.decisionProvider).toBeNull();
    expect(failover.decisionTimeoutMs).toBeNull();
    const body = toPutBody(failover).combo;
    expect(Object.hasOwn(body, "decisionProvider")).toBe(false);
    expect(Object.hasOwn(body, "decisionTimeoutMs")).toBe(false);
    // Even a stale draft value never reaches the wire for a non-JEV strategy.
    expect(Object.hasOwn(toPutBody({ ...jev, strategy: "round-robin" }).combo, "decisionProvider")).toBe(false);
    // Switching back to jev keeps the (cleared) fields rather than resurrecting old ones.
    expect(withComboStrategy(failover, "jev").decisionProvider).toBeNull();
    expect(withComboStrategy(jev, "jev")).toEqual(jev);
  });

  test("timeout validation follows the server bounds and applies only to jev", () => {
    const jev = parseOne({ strategy: "jev" });
    const validate = (item: ComboItem) => validateComboDraft(item, {
      existingIds: [],
      isCreate: false,
      providers: { a: {} },
    });
    expect(validate({ ...jev, decisionTimeoutMs: null })).toBeNull();
    expect(validate({ ...jev, decisionTimeoutMs: 1000 })).toBeNull();
    expect(validate({ ...jev, decisionTimeoutMs: 120000 })).toBeNull();
    expect(validate({ ...jev, decisionTimeoutMs: 999 })).toBe("invalidDecisionTimeout");
    expect(validate({ ...jev, decisionTimeoutMs: 120001 })).toBe("invalidDecisionTimeout");
    expect(validate({ ...jev, decisionTimeoutMs: 1500.5 })).toBe("invalidDecisionTimeout");
    expect(validate({ ...jev, strategy: "failover", decisionTimeoutMs: 5 })).toBeNull();
  });

  test("decision service options list TypeSafe first, then self-hosted jev-decision rows", () => {
    expect(jevDecisionServiceOptions(providers)).toEqual([
      { id: null },
      { id: "mytev", baseUrl: "https://local.example/v1/systemone" },
      { id: "tev-local", baseUrl: "http://127.0.0.1:11434/v1/systemone" },
    ]);
    // A stored id with no matching row stays selectable instead of being silently rewritten.
    expect(jevDecisionServiceOptions(providers, "gone").at(-1)).toEqual({ id: "gone", missing: true });
    expect(jevDecisionServiceOptions(providers, "jev")).toHaveLength(3);
  });

  test("the read-only summary names the service, its endpoint and timeout", () => {
    expect(jevDecisionSummary(parseOne({ strategy: "failover" }), providers)).toBeNull();
    expect(jevDecisionSummary(parseOne({ strategy: "jev" }), providers))
      .toEqual({ provider: null, baseUrl: null, timeoutMs: null });
    expect(jevDecisionSummary(
      parseOne({ strategy: "jev", decisionProvider: "mytev", decisionTimeoutMs: 30000 }),
      providers,
    )).toEqual({ provider: "mytev", baseUrl: "https://local.example/v1/systemone", timeoutMs: 30000 });
  });

  test("JEV Auto pre-fills a self-hosted decision service and keeps TypeSafe by default", () => {
    const models = [{ provider: "openai", id: "gpt-6-astra" }];
    expect(jevAutoDraft(models).decisionProvider).toBeNull();
    expect(jevAutoDraft(models, undefined, "jev").decisionProvider).toBeNull();
    const selfHosted = jevAutoDraft(models, undefined, "tev-local");
    expect(selfHosted.decisionProvider).toBe("tev-local");
    expect(toPutBody(selfHosted).combo.decisionProvider).toBe("tev-local");
  });

  test("Create JEV Auto: key required for canonical jev only, and the deep link carries the row", () => {
    expect(canCreateJevAutoFrom({ name: "jev", adapter: "jev-decision", hasApiKey: true })).toBe(true);
    expect(canCreateJevAutoFrom({ name: "jev", adapter: "jev-decision", hasApiKey: false })).toBe(false);
    expect(canCreateJevAutoFrom({ name: "tev-local", adapter: "jev-decision", hasApiKey: false })).toBe(true);
    expect(canCreateJevAutoFrom({ name: "a", adapter: "openai-chat", hasApiKey: true })).toBe(false);

    expect(jevAutoCreateHash("jev")).toBe(JEV_AUTO_CREATE_HASH);
    expect(jevAutoCreateHash()).toBe(JEV_AUTO_CREATE_HASH);
    const hash = jevAutoCreateHash("tev local");
    expect(hash).toBe(`${JEV_AUTO_CREATE_HASH}?decisionProvider=tev+local`);
    expect(jevAutoCreateDecisionProvider(`#${hash}`)).toBe("tev local");
    expect(jevAutoCreateDecisionProvider(`#${JEV_AUTO_CREATE_HASH}`)).toBeNull();
    expect(jevAutoCreateDecisionProvider("#models/combos")).toBeUndefined();
    // The router keeps the query on this action link instead of stripping it.
    expect(resolveAppHashChange(hash)).toEqual({ page: "models", replaceTo: null });
  });
});
