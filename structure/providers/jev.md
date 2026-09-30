# JEV Decision Provider

The JEV Combo strategy asks a decision service for one target and reasoning effort per request. This
doc owns the decision provider rows, the decision request, and the JEV projections; general provider
and adapter selection stays in [providers-and-adapters.md](../providers-and-adapters.md).

## TypeSafe JEV decision provider

`src/providers/registry/entries-extended.ts` owns the canonical `jev` key preset at
`https://api.typesafe.ai/v1/systemone` with adapter `jev-decision`. It is a credential owner, not an
inference route: the registry marks it `credentialOnly`, its adapter is deliberately absent from the
routable adapter registry, live discovery is disabled, no default/static model is published, and
key login returns unknown without probing a nonexistent model catalog. The normal `ocx login jev`
flow and provider-workspace API-key panel both persist the same credential-only row. Combo validation
rejects every `jev-decision` row as a target; `src/codex/catalog/gather-capture.ts` never gathers one.
`src/server/management/provider-routes.ts` tests those rows through `probeJevDecisionProvider`
(no user prompt, sanitized status); a retargeted `jev` row reports not-applicable and sends nothing.

The request path consumes a configured literal/reference key only when the row still matches the
canonical registry transport, with `TYPESAFE_API_KEY` and the standard provider-derived
`JEV_API_KEY` as explicit environment fallbacks. A same-named custom destination cannot receive
either credential through the JEV client; a retargeted `jev` row is ignored, never a custom
destination. Automated coverage mocks TypeSafe; live-key behavior is an operator smoke boundary. A Combo's `decisionProvider` selects the service: omitted or `"jev"` (stored as omission) is that
canonical path with `jev-latest`; any other id must be an enabled `jev-decision` row with a full
`/systemone` `baseUrl` and a `defaultModel`/`models[0]`, sending only its own `apiKey` (a TypeSafe
env reference or foreign keychain entry makes it unusable). `allowLocalCleartextPost` in
`src/lib/provider-outbound.ts` admits `http:` only with the row's explicit `allowPrivateNetwork`, a
`localhost`/loopback/RFC 1918/ULA host whose answers stay in that set, and no proxy. Options go out as
strings (Ollama requires them); under 2 or over 26 fail open locally (`no_choices`/`invalid`), unusable
rows reuse `missing_key`, and `decisionTimeoutMs` (1000..120000) replaces the 4 s default.

`src/combos/jev.ts` extracts bounded user-task, previous-assistant, and latest-tool-output text plus
the tool name and boolean signals; raw image data, tool arguments, encrypted reasoning, headers, and
the JEV credential are excluded. It owns the joint target/effort choice map, strict response
validation, canonical `jev-latest` destination, default four-second deadline, no-redirect policy, bounded response,
and caller-cancellation propagation. Missing credentials or safe state, transport failures, and invalid
answers fail open to the first eligible target; no response can escape the configured choice map.
Telemetry never retains extracted state or credentials.

The optional `targets[].modelProfile` note is validated at the Combo management input boundary to a
non-empty string of at most 512 characters; tab, line feed and carriage return are allowed for
multi-line notes, every other C0 control character and DEL is refused, and the value is stored
sparsely. `src/combos/jev.ts` sends a configured target note as `state.operator_notes` on a JEV
decision, keyed by target; built-in `instructions.model_profiles` and the target/effort allowlist stay
authoritative. The note reaches TypeSafe with each applicable decision, so operators must keep secrets
and private paths out of it. An absent note leaves the prior decision payload shape intact.

`src/server/responses/core-combo.ts` computes current eligibility, asks JEV once for the initial pick,
applies the validated effort, and removes caller `service_tier` for that child. A retryable child
failure re-enters the ordinary Combo fallback loop from the untouched request without another JEV
call. Each target may carry an optional non-empty `reasoningEfforts` allowlist. Omission keeps the
backward-compatible all-advertised behavior; a present list is intersected with current capabilities,
and an empty intersection removes that target from the JEV choice map rather than broadening it.
Direct models and every other Combo strategy bypass this path. The shared Combo editor owns the GUI
checkboxes and `Create JEV Auto` template; no second model picker or JEV-only editor exists.

JEV setup stays inside those existing shells. A configured `jev-decision` provider Overview exposes
**Create JEV Auto**, which navigates to the registered `models/combos/jev-auto` action hash.
`gui/src/pages/Combos.tsx` owns that one-shot add intent and normalizes the hash when the modal
closes; `ComboWorkspace` and `combo-workspace-add-modal.tsx` reuse the ordinary Combo form and target
editor with a pure template from `combo-workspace-data.ts`. The template includes only currently
available Astra/Sol/Luna rows, remains fully editable, marks the first eligible row as fail-open,
and displays known effort ladders. The JEV provider is hidden from the target picker because it owns
only the decision credential. Existing model rows, default selection, and direct picker behavior are
unchanged; an existing `jev-auto` id or alias disables or reports the quick action.
An existing JEV Combo adds a lazy **Stats** detail tab. It polls only while visible, uses the
management API's JEV projection, and keeps decision-service tokens separate from physical model
tokens. Config remains the ordinary editable Combo form, including per-target effort allowlists.

`src/usage/jev-stats.ts` owns the parallel content-free JEV projection. Its retained accumulator is
keyed by Combo and stable preset boundary, shares concurrent reads, verifies append identity and LF
digest, clones before folding a suffix, and starts a fresh accumulator after a rebuild-required
scan. It counts physical sends from `attempts[].sendCount`, ignores zero-send rows for fallback
detection, and folds identities beyond 255 concrete rows into one explicit overflow row while
preserving global totals. Up to four JEV projections participate in the same app-owned memory budget
and eviction path as ordinary usage aggregates. Read failure returns HTTP 500 rather than a partial
projection.

## Quota signals

`combos[*].decisionQuotaSignals: true` (JEV only, validated and stored sparsely beside
`decisionProvider`/`decisionTimeoutMs`, and carried across a management PUT that omits it while the
strategy stays `jev`) makes `src/server/responses/core-combo.ts` attach a `JevCandidate.quota` to each
eligible target. Off, no candidate carries one and the decision request is byte-identical.

`src/combos/jev-quota.ts` owns the signal. It reads the provider quota report cache through
`getCachedProviderQuota` — the rows `ocx provider quota` and the Providers page publish: the Codex
pool aggregate (else the effective account), the active OAuth account, or the active key —
synchronously, and never probes, so a decision cannot wait on quota. Rows older than
`JEV_QUOTA_SIGNAL_MAX_AGE_MS` (30 minutes), future-stamped rows, and windows whose reset has passed are
unknown and contribute nothing. The worst of the 5h, weekly, and monthly meters plus a `scope: "model"`
family window that the model id names sets the tier: under 70% healthy, under 90% limited, otherwise
nearly exhausted. Unscoped custom windows and USD credits never count, because they do not describe
the model's subscription allowance.

`buildJevRouteQuestion` in `src/combos/jev.ts` appends one tier clause to each self-hosted description
string, or a `quota` object (`tier`, `used_percent`, `window`, `resets_in_seconds`) to each TypeSafe
criterion, and adds `instructions.quota` only when some target has a signal. Measured with `tev1`, the
same facts in `model_profiles` alone barely moved a decision, which is why they ride in the options. A
body that exceeds `JEV_MAX_REQUEST_BYTES` only because of quota is rebuilt without it;
`JevDecision.quotaSent` records whether the posted body carried quota, and only then does
`core-combo.ts` persist `jevDecision.quota` (target counts per tier and the picked target's tier,
re-validated in `src/usage/jev-stats.ts`, no account identity). The signal is advisory: eligibility
and exhaustion vetoes stay in `src/combos/resolve.ts`.
