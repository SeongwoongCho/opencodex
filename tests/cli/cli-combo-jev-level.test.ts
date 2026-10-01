import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleComboCommand } from "../../src/cli/combo";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime() {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

const levels = {
  trivial: { candidates: [{ provider: "openai", model: "gpt-6-luna", effort: "low" }] },
  hard: { candidates: [{ provider: "openai", model: "gpt-6-astra", effort: "xhigh" }] },
};
const base = ["set", "jev-local", "--targets", "openai/gpt-6-astra,openai/gpt-6-luna", "--strategy", "jev"];

describe("ocx combo set level mode", () => {
  test("sends decisionMode, decisionLevels and decisionFallbackLevel, and clears each with -", async () => {
    const runtime = fakeRuntime();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleComboCommand([
        ...base, "--decision-mode", "level", "--decision-levels", JSON.stringify(levels),
        "--decision-fallback-level", "trivial", "--json",
      ], runtime.deps)).toBe(0);
      expect(await handleComboCommand([
        ...base, "--decision-mode", "-", "--decision-levels", "-", "--decision-fallback-level", "-", "--json",
      ], runtime.deps)).toBe(0);
      expect(await handleComboCommand([...base, "--decision-mode", "route", "--json"], runtime.deps)).toBe(0);
      expect(await handleComboCommand([...base, "--json"], runtime.deps)).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
    const puts = runtime.requests.filter(request => request.method === "PUT").map(request => (request.body as { combo: Record<string, unknown> }).combo);
    expect(puts[0]).toMatchObject({ decisionMode: "level", decisionLevels: levels, decisionFallbackLevel: "trivial" });
    expect(puts[1]).toMatchObject({ decisionMode: null, decisionLevels: null, decisionFallbackLevel: null });
    expect(puts[2]).toMatchObject({ decisionMode: "route" });
    // Omission lets the server keep what is stored.
    for (const field of ["decisionMode", "decisionLevels", "decisionFallbackLevel"]) expect(puts[3]).not.toHaveProperty(field);
  });

  test("rejects bad values and non-jev strategies before any request", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const args of [
        ["--strategy", "jev", "--decision-mode", "auto"],
        ["--strategy", "jev", "--decision-levels", "{not json"],
        ["--strategy", "jev", "--decision-levels", "[]"],
        ["--strategy", "jev", "--decision-fallback-level", "expert"],
        ["--decision-mode", "level"],
        ["--strategy", "failover", "--decision-levels", JSON.stringify(levels)],
        ["--strategy", "round-robin", "--decision-fallback-level", "hard"],
      ]) {
        const rejected = fakeRuntime();
        expect(await handleComboCommand(["set", "demo", "--targets", "a/m1", ...args], rejected.deps)).toBe(2);
        expect(rejected.requests).toEqual([]);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("ocx combo set decision prompt", () => {
  test("sets, omits and clears the JSON prompt", async () => {
    const runtime = fakeRuntime();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const decisionPrompt = { levelInstructions: "Custom classification." };
    try {
      for (const flags of [["--decision-prompt", JSON.stringify(decisionPrompt)], [], ["--decision-prompt", "-"]]) {
        expect(await handleComboCommand([...base, ...flags, "--json"], runtime.deps)).toBe(0);
      }
    } finally { logSpy.mockRestore(); }
    const puts = runtime.requests.filter(row => row.method === "PUT").map(row => (row.body as { combo: Record<string, unknown> }).combo);
    expect(puts[0]!.decisionPrompt).toEqual(decisionPrompt);
    expect(puts[1]).not.toHaveProperty("decisionPrompt");
    expect(puts[2]!.decisionPrompt).toBeNull();
  });
  test("rejects malformed JSON and non-JEV prompt usage without a request", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const flags of [["--strategy", "jev", "--decision-prompt", "{"], ["--strategy", "jev", "--decision-prompt", "[]"], ["--decision-prompt", "{}"]]) {
        const runtime = fakeRuntime();
        expect(await handleComboCommand(["set", "auto", "--targets", "a/m", ...flags], runtime.deps)).toBe(2);
        expect(runtime.requests).toEqual([]);
      }
    } finally { errorSpy.mockRestore(); }
  });
});
