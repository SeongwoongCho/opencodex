/**
 * Which configured provider rows can serve as a JEV decision service. Mirrors what the server
 * accepts (src/combos/types.ts comboConfigIssues) and what it will actually call
 * (src/combos/jev.ts jevDecisionEndpoint), so the dashboard never offers a row that a save would
 * reject or the runtime would silently ignore.
 */
import {
  CANONICAL_JEV_DECISION_PROVIDER,
  isSystemOneEndpoint,
} from "../../src/combos/jev-decision-contract";

export {
  CANONICAL_JEV_DECISION_PROVIDER,
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
} from "../../src/combos/jev-decision-contract";

export interface JevDecisionRow {
  adapter?: string;
  baseUrl?: string;
  disabled?: boolean;
  defaultModel?: string;
  models?: readonly string[];
}

/**
 * Why a self-hosted decision service is unusable. The management API rejects every issue on save;
 * config-file load rejects only `missing`, `notDecision` and `endpoint` (the runtime skips the rest).
 */
export type JevDecisionIssue = "missing" | "notDecision" | "disabled" | "endpoint" | "model";

export function jevDecisionRowIssue(row: JevDecisionRow | undefined): JevDecisionIssue | null {
  if (!row) return "missing";
  if (row.adapter !== "jev-decision") return "notDecision";
  if (row.disabled === true) return "disabled";
  if (!isSystemOneEndpoint(row.baseUrl ?? "")) return "endpoint";
  if (!row.defaultModel?.trim() && !row.models?.[0]?.trim()) return "model";
  return null;
}

/**
 * Whether a provider row offers "Create JEV Auto". The canonical `jev` row needs its TypeSafe
 * key; a self-hosted row may be keyless (e.g. a loopback Ollama endpoint) but must be usable.
 */
export function canCreateJevAutoFrom(row: JevDecisionRow & { name: string; hasApiKey?: boolean }): boolean {
  if (row.name === CANONICAL_JEV_DECISION_PROVIDER) {
    return row.adapter === "jev-decision" && row.disabled !== true && row.hasApiKey === true;
  }
  return jevDecisionRowIssue(row) === null;
}
