import { isCodexReasoningEffort, resolveEffortAtOrBelow } from "../reasoning-effort";
import type { OcxComboDefaultEffort } from "../types";
import {
  JEV_DEFAULT_FALLBACK_LEVEL,
  JEV_LEVEL_INSTRUCTIONS,
  type JevDecisionPrompt,
  JEV_LEVEL_DEFAULT_DESCRIPTIONS,
  type JevLevelId,
  type JevLevelPath,
  type JevQuotaTier,
} from "./jev-decision-contract";
import {
  buildJevState,
  exchangeJevDecision,
  fitsJevRequestBytes,
  hasJevDecisionState,
  jevChoiceProbability,
  jevConfidence,
  jevUsage,
  type JevCandidate,
  type JevDecision,
  type ResolveJevDecisionOptions,
} from "./jev";
import { configuredJevLevelIds, type NormalizedJevLevel, type NormalizedJevLevels } from "./jev-level-config";

/**
 * JEV level mode (`decisionMode: "level"`).
 *
 * The decision model answers one small question: how demanding the next model call is, as one of
 * the Combo's configured levels. ocx then walks that level's ordered candidate list and picks the
 * first usable target and effort, deterministically and synchronously. Target profiles and quota
 * never enter the request; quota-aware selection (`decisionQuotaSignals: true`) is applied here,
 * from the same cached tiers route mode sends, so it is reliable instead of advisory.
 */

export { JEV_LEVEL_INSTRUCTIONS } from "./jev-decision-contract";

/** Self-hosted System One choice questions accept 2..26 options. */
const MIN_LEVEL_OPTIONS = 2;

const TIER_RANK: Record<JevQuotaTier, number> = { healthy: 0, limited: 1, nearly_exhausted: 2 };

export interface JevLevelDecision extends JevDecision {
  /** The classified level; absent when no decision was applied. */
  level?: JevLevelId;
  /** Which selection produced `targetKey` and `effort`. */
  levelPath: JevLevelPath;
  /** Candidates the selection weighed (the used level's usable ones), for the quota summary. */
  considered?: readonly JevCandidate[];
}

export interface ResolveJevLevelDecisionOptions extends Omit<ResolveJevDecisionOptions, "candidates"> {
  /** Currently eligible targets with their allowed efforts (the route-mode choice set). */
  candidates: readonly JevCandidate[];
  levels: NormalizedJevLevels;
  fallbackLevel?: JevLevelId;
  /** Prefer healthier quota tiers (each candidate's `quota`) within a level. */
  quotaAware?: boolean;
}

/** The single `level` choice question: configured levels in canonical order, plain string criteria. */
export function buildJevLevelQuestion(levels: NormalizedJevLevels, decisionPrompt?: JevDecisionPrompt): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const id of configuredJevLevelIds(levels)) {
    criteria[id] = levels[id]?.description ?? JEV_LEVEL_DEFAULT_DESCRIPTIONS[id];
  }
  return { level: { type: "choice", instructions: decisionPrompt?.levelInstructions ?? JEV_LEVEL_INSTRUCTIONS, criteria } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJevLevelDecision(
  payload: unknown,
  offered: readonly JevLevelId[],
): { level: JevLevelId; confidence?: number; chosenProbability?: number; usage?: Record<string, number> } {
  if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.level)) {
    throw new Error("missing JEV level decision");
  }
  const answer = payload.answers.level;
  if (typeof answer.choice !== "string" || !(offered as readonly string[]).includes(answer.choice)) {
    throw new Error("unknown JEV level choice");
  }
  const chosenProbability = jevChoiceProbability(answer, offered, "level");
  const confidence = jevConfidence(answer.confidence);
  const usage = jevUsage(payload);
  return {
    level: answer.choice as JevLevelId,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(chosenProbability !== undefined ? { chosenProbability } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Effort for a candidate that names none: the fail-open rule, medium or the next lower allowed. */
function defaultEffort(candidate: JevCandidate): OcxComboDefaultEffort | null {
  const effort = resolveEffortAtOrBelow("medium", candidate.reasoningEfforts);
  return effort && isCodexReasoningEffort(effort) ? effort as OcxComboDefaultEffort : null;
}

/**
 * Pick from one level's ordered candidates. A candidate is usable when its target is among the
 * currently eligible `candidates` (cooldown, disabled, lastResort deferral, capability) and its
 * effort, if named, is one that target still allows. Quota-aware, the first usable candidate in
 * the best tier wins (healthy or unknown, then limited, then nearly exhausted); otherwise the
 * first usable one. Undefined when nothing in the level is usable.
 */
export function selectJevLevelCandidate(
  level: NormalizedJevLevel | undefined,
  candidates: readonly JevCandidate[],
  quotaAware = false,
): { targetKey: string; effort: OcxComboDefaultEffort | null; considered: JevCandidate[] } | undefined {
  if (!level) return undefined;
  const usable: Array<{ candidate: JevCandidate; effort: OcxComboDefaultEffort | null }> = [];
  for (const wanted of level.candidates) {
    const candidate = candidates.find(item => item.provider === wanted.provider && item.model === wanted.model);
    if (!candidate) continue;
    if (wanted.effort !== undefined && !candidate.reasoningEfforts.includes(wanted.effort)) continue;
    usable.push({ candidate, effort: wanted.effort ?? defaultEffort(candidate) });
  }
  if (usable.length === 0) return undefined;
  let best = usable[0]!;
  if (quotaAware) {
    const rank = (entry: typeof best) => entry.candidate.quota ? TIER_RANK[entry.candidate.quota.tier] : 0;
    for (const entry of usable) if (rank(entry) < rank(best)) best = entry;
  }
  const considered = [...new Map(usable.map(entry => [entry.candidate.key, entry.candidate])).values()];
  return { targetKey: best.candidate.key, effort: best.effort, considered };
}

/**
 * Classify the next call's demand level and select a target and effort for it.
 *
 * Decision failures reuse the route-mode gates and the supplied first-eligible fallback
 * (`levelPath: "fail_open"`). A level with no usable candidate tries the fallback level, then
 * fails open. A caller abort is rethrown by identity.
 */
export async function resolveJevLevelDecision(options: ResolveJevLevelDecisionOptions): Promise<JevLevelDecision> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, now() - startedAt);
  const failed = (gate: Exclude<JevDecision["gate"], "apply">): JevLevelDecision => ({
    ...options.fallback,
    gate,
    latencyMs: elapsed(),
    levelPath: "fail_open",
  });

  if (options.signal?.aborted) throw options.signal.reason;
  if (options.candidates.length === 0) return failed("no_choices");
  const offered = configuredJevLevelIds(options.levels);
  if (offered.length < MIN_LEVEL_OPTIONS) return failed("no_choices");

  const exchanged = await exchangeJevDecision(options, (endpoint) => {
    // Target notes describe targets, which this question does not offer.
    const state = buildJevState(options.body);
    if (!hasJevDecisionState(state)) return "no_state";
    const body = JSON.stringify({ model: endpoint.model, state, questions: buildJevLevelQuestion(options.levels, options.decisionPrompt) });
    return fitsJevRequestBytes(body) ? { body } : "invalid";
  });
  if ("gate" in exchanged) return failed(exchanged.gate);

  let parsed: ReturnType<typeof parseJevLevelDecision>;
  try {
    parsed = parseJevLevelDecision(exchanged.payload, offered);
  } catch {
    return failed("invalid");
  }
  if (options.signal?.aborted) throw options.signal.reason;

  const decided = {
    gate: "apply" as const,
    level: parsed.level,
    ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
    ...(parsed.chosenProbability !== undefined ? { chosenProbability: parsed.chosenProbability } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  };
  const quotaAware = options.quotaAware === true;
  const chosen = selectJevLevelCandidate(options.levels[parsed.level], options.candidates, quotaAware);
  if (chosen) {
    return { ...decided, targetKey: chosen.targetKey, effort: chosen.effort, considered: chosen.considered, latencyMs: elapsed(), levelPath: "chosen" };
  }
  const fallbackLevel = options.fallbackLevel ?? JEV_DEFAULT_FALLBACK_LEVEL;
  const fallback = fallbackLevel === parsed.level
    ? undefined
    : selectJevLevelCandidate(options.levels[fallbackLevel], options.candidates, quotaAware);
  if (fallback) {
    return { ...decided, targetKey: fallback.targetKey, effort: fallback.effort, considered: fallback.considered, latencyMs: elapsed(), levelPath: "fallback_level" };
  }
  return { ...decided, ...options.fallback, latencyMs: elapsed(), levelPath: "fail_open" };
}
