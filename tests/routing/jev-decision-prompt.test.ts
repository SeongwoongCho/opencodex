import { describe, expect, test } from "bun:test";
import { comboConfigIssues, normalizeComboConfig } from "../../src/combos/types";
import { buildJevRouteQuestion, resolveJevDecision, type JevCandidate, type ResolveJevDecisionOptions } from "../../src/combos/jev";
import { buildJevLevelQuestion, resolveJevLevelDecision } from "../../src/combos/jev-level";
import { JEV_EFFORT_DEFAULT_PROFILES, JEV_LEVEL_INSTRUCTIONS, JEV_PROMPT_MAX_FIELD_CHARS, JEV_ROUTE_DEFAULT_INSTRUCTIONS, normalizeJevPromptFields, type JevDecisionPrompt } from "../../src/combos/jev-decision-contract";
import type { OcxComboConfig, OcxConfig } from "../../src/types";

const candidates: JevCandidate[] = [
  { key: "a/one", provider: "a", model: "one", reasoningEfforts: ["low", "high"] },
  { key: "a/two", provider: "a", model: "two", reasoningEfforts: ["low", "high"] },
];
const targets = candidates.map(({ provider, model }) => ({ provider, model }));
const levels = { trivial: { candidates: [targets[0]!] }, routine: { candidates: [targets[1]!] } };
const providers = { a: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } as OcxConfig["providers"];
const combo = { strategy: "jev", targets } as OcxComboConfig;
const config = { port: 0, defaultProvider: "a", providers: {
  ...providers,
  local: { adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", allowPrivateNetwork: true, defaultModel: "tev1:4b" },
} } as OcxConfig;

function instructions(prompt?: JevDecisionPrompt, descriptiveCriteria = false) {
  return (buildJevRouteQuestion(candidates, { decisionPrompt: prompt, descriptiveCriteria }).route as { instructions: Record<string, unknown> }).instructions;
}

describe("JEV per-combo decision wording", () => {
  test("substitutes every route field independently without changing criteria or other instructions", () => {
    for (const descriptiveCriteria of [false, true]) {
      const baseline = buildJevRouteQuestion(candidates, { descriptiveCriteria });
      for (const key of Object.keys(JEV_ROUTE_DEFAULT_INSTRUCTIONS) as Array<keyof typeof JEV_ROUTE_DEFAULT_INSTRUCTIONS>) {
        const custom = `Custom ${key}.`;
        const prompt = { route: { [key]: custom } };
        expect(instructions(prompt, descriptiveCriteria)).toEqual({ ...instructions(undefined, descriptiveCriteria), [key]: custom });
        expect((buildJevRouteQuestion(candidates, { decisionPrompt: prompt, descriptiveCriteria }).route as { criteria: unknown }).criteria)
          .toEqual((baseline.route as { criteria: unknown }).criteria);
      }
      for (const effort of Object.keys(JEV_EFFORT_DEFAULT_PROFILES)) {
        expect(instructions({ route: { effortProfiles: { [effort]: "Custom effort." } } }, descriptiveCriteria).effort_profiles)
          .toEqual({ ...JEV_EFFORT_DEFAULT_PROFILES, [effort]: "Custom effort." });
      }
    }
  });

  test("substitutes the level instruction and descriptions without sending target text", () => {
    const question = buildJevLevelQuestion({ ...levels, trivial: { ...levels.trivial, description: "Custom trivial." } }, { levelInstructions: "Custom classification." });
    expect(question.level).toMatchObject({ instructions: "Custom classification.", criteria: { trivial: "Custom trivial." } });
    expect(JSON.stringify(question)).not.toContain("a/one");
    expect(buildJevLevelQuestion(levels).level).toMatchObject({ instructions: JEV_LEVEL_INSTRUCTIONS });
  });

  test("stores only trimmed non-default overrides and drops empty containers", () => {
    const decisionPrompt = { levelInstructions: " Custom level. \n", route: { question: " Custom question. ", speed: JEV_ROUTE_DEFAULT_INSTRUCTIONS.speed, effortProfiles: { low: " Custom low. ", high: JEV_EFFORT_DEFAULT_PROFILES.high } } };
    expect(normalizeComboConfig({ ...combo, decisionPrompt }).decisionPrompt).toEqual({ levelInstructions: "Custom level.", route: { question: "Custom question.", effortProfiles: { low: "Custom low." } } });
    for (const decisionPrompt of [undefined, null, {}, { route: {} }, { route: { effortProfiles: {} } }, { levelInstructions: JEV_LEVEL_INSTRUCTIONS }]) {
      expect(normalizeJevPromptFields({ decisionPrompt })).toEqual({});
    }
  });

  test("validates strategy, containers, known fields, bounded non-empty text and control characters", () => {
    for (const decisionPrompt of [null, {}, { route: {} }, { levelInstructions: "Line\ttext\nnext\rline" }, { route: { effortProfiles: { low: "x".repeat(JEV_PROMPT_MAX_FIELD_CHARS) } } }]) {
      expect(comboConfigIssues("auto", { ...combo, decisionPrompt }, providers)).toEqual([]);
    }
    for (const decisionPrompt of [[], "bad", { unknown: "bad" }, { route: null }, { route: { unknown: "bad" } }, { route: { effortProfiles: [] } }, { route: { effortProfiles: { extreme: "bad" } } }]) {
      expect(comboConfigIssues("auto", { ...combo, decisionPrompt }, providers).length).toBeGreaterThan(0);
    }
    for (const bad of ["", " \n ", null, 1, "x".repeat(JEV_PROMPT_MAX_FIELD_CHARS + 1), "bad\u0000", "bad\u000b", "bad\u007f"]) {
      for (const decisionPrompt of [{ levelInstructions: bad }, { route: { question: bad } }, { route: { effortProfiles: { low: bad } } }]) {
        expect(comboConfigIssues("auto", { ...combo, decisionPrompt }, providers)[0]?.path[0]).toBe("decisionPrompt");
      }
    }
    expect(comboConfigIssues("auto", { ...combo, strategy: "failover", decisionPrompt: {} }, providers)[0]?.message).toContain('strategy "jev"');
  });

  test("real decision posts carry overrides in both modes", async () => {
    const requests: Array<{ questions: Record<string, { instructions: unknown }> }> = [];
    const post = (async (_name, _provider, _url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({});
    }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    const base = { body: { input: "Review this function." }, candidates, config, decisionProvider: "local", fallback: { targetKey: candidates[0]!.key, effort: null }, post };
    await resolveJevDecision({ ...base, decisionPrompt: { route: { question: "Custom request question." } } });
    await resolveJevLevelDecision({ ...base, levels, decisionPrompt: { levelInstructions: "Custom request classification." } });
    expect(requests[0]!.questions.route!.instructions).toMatchObject({ question: "Custom request question." });
    expect(requests[1]!.questions.level!.instructions).toBe("Custom request classification.");
  });

  test("an oversized decision request fails open as invalid before posting, in both modes", async () => {
    let posts = 0;
    const post = (async () => { posts++; return Response.json({}); }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    const base = { body: { input: "Review this function." }, candidates, config, decisionProvider: "local", fallback: { targetKey: candidates[0]!.key, effort: null }, post };
    expect((await resolveJevDecision({ ...base, decisionPrompt: { route: { question: "x".repeat(70_000) } } })).gate).toBe("invalid");
    expect((await resolveJevLevelDecision({ ...base, levels, decisionPrompt: { levelInstructions: "x".repeat(70_000) } })).gate).toBe("invalid");
    expect(posts).toBe(0);
  });
});
