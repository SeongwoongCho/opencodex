import { describe, expect, test } from "bun:test";
import type { JevCandidate } from "../../src/combos/jev";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import { JEV_LEVEL_DEFAULT_DESCRIPTIONS } from "../../src/combos/jev-decision-contract";
import { JEV_MODEL_LEVEL_INSTRUCTIONS, resolveJevLevelDecision } from "../../src/combos/jev-level";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import { JevModelInvokeError, type JevModelInvoke, type JevModelInvokeRequest } from "../../src/combos/jev-model-backend";
import type { OcxConfig } from "../../src/types";

const config = { port: 0, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
const candidates: JevCandidate[] = [
  { key: "a/fast", provider: "a", model: "fast", reasoningEfforts: ["low", "medium"] },
  { key: "b/deep", provider: "b", model: "deep", reasoningEfforts: ["low", "xhigh"] },
];
const levels: NormalizedJevLevels = {
  trivial: { candidates: [{ provider: "a", model: "fast", effort: "low" }] },
  hard: { description: "Hard work.", candidates: [{ provider: "b", model: "deep", effort: "xhigh" }] },
};
const fallback = { targetKey: "a/fast", effort: "medium" as const };
const body = { input: "Fix the data race in the scheduler." };

function invoking(text: string, calls: JevModelInvokeRequest[] = []): JevModelInvoke {
  return async request => {
    calls.push(request);
    return { text, usage: { input_tokens: 120, output_tokens: 4 } };
  };
}

describe("level mode through a decision model", () => {
  test("asks the model for a configured level and selects that level's candidate", async () => {
    const calls: JevModelInvokeRequest[] = [];
    const decision = await resolveJevLevelDecision({
      body, candidates, fallback, config, levels,
      decisionModel: " router/small ",
      invokeModel: invoking('{"choice":"hard"}', calls),
    });
    expect(decision).toMatchObject({
      backend: "model", gate: "apply", level: "hard", levelPath: "chosen",
      targetKey: "b/deep", effort: "xhigh", usage: { input_tokens: 120, output_tokens: 4 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("router/small");
    expect(calls[0]!.instructions).toBe(JEV_MODEL_LEVEL_INSTRUCTIONS);
    const input = JSON.parse(calls[0]!.input) as { state: { task: string }; options: Record<string, string> };
    expect(input.options).toEqual({ trivial: JEV_LEVEL_DEFAULT_DESCRIPTIONS.trivial, hard: "Hard work." });
    expect(input.state.task).toContain("data race");
    // Level questions never carry target identities.
    expect(calls[0]!.input).not.toContain("b/deep");
  });

  test("fails open on a missing invoker, an unknown level, or an invoke error", async () => {
    const base = { body, candidates, fallback, config, levels, decisionModel: "router/small" };
    expect(await resolveJevLevelDecision(base))
      .toMatchObject({ backend: "model", gate: "missing_key", levelPath: "fail_open", ...fallback });
    expect(await resolveJevLevelDecision({ ...base, invokeModel: invoking('{"choice":"expert"}') }))
      .toMatchObject({ gate: "invalid", levelPath: "fail_open", ...fallback });
    expect(await resolveJevLevelDecision({ ...base, invokeModel: async () => { throw new JevModelInvokeError("http"); } }))
      .toMatchObject({ gate: "http", levelPath: "fail_open", ...fallback });
    expect(await resolveJevLevelDecision({ ...base, body: { input: "  " }, invokeModel: invoking('{"choice":"hard"}') }))
      .toMatchObject({ gate: "no_state", levelPath: "fail_open" });
  });

  test("the combo dispatcher enters level mode for either backend", async () => {
    const decision = await resolveJevComboDecision({
      body, candidates, fallback, config, levels,
      decisionModel: "router/small", invokeModel: invoking('{"choice":"trivial"}'),
    });
    expect(decision).toMatchObject({ backend: "model", level: "trivial", levelPath: "chosen", targetKey: "a/fast", effort: "low" });
    // Without levels the dispatcher keeps the route-mode model contract.
    const route = await resolveJevComboDecision({
      body, candidates, fallback, config,
      decisionModel: "router/small", invokeModel: invoking('{"choice":"b/deep:xhigh"}'),
    });
    expect(route).toMatchObject({ backend: "model", gate: "apply", targetKey: "b/deep", effort: "xhigh" });
    expect(route).not.toHaveProperty("levelPath");
  });

  test("a caller abort is rethrown by identity", async () => {
    const controller = new AbortController();
    const reason = new Error("client gone");
    const invokeModel: JevModelInvoke = async () => {
      controller.abort(reason);
      return { text: '{"choice":"hard"}' };
    };
    await expect(resolveJevLevelDecision({
      body, candidates, fallback, config, levels, decisionModel: "router/small", invokeModel, signal: controller.signal,
    })).rejects.toBe(reason);
  });
});
