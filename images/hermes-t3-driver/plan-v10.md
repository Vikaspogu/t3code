# Hermes native T3 provider plan, revision 10

Date: 2026-11-21
Status: G1 approved by Kimi K3.1 Pro and Claude Opus 5.5, both 10/10 on 2026-11-21; G2 and later gates remain separate
Minimum runtime: Hermes v0.23.3
Supersedes: revision 9 to use the deployed interrupt field and started-receipt generation, record compression-lineage behavior, and separate Hermes protocol G0 from provider implementation fault-injection tests. The approved native Gateway architecture and all unrelated requirements remain.

## 1. Decision requested and approved

The user selected **Revise native plan** after G0 proved that Hermes v0.23.3 loses open approval and clarify prompts across a Gateway restart. The native provider may explicitly fail those interrupted interactions instead of requiring upstream durable server-request persistence.

This is not permission to silently drop a turn, invent an answer, auto-deny a tool, or retry a prompt in a way that could execute it twice.

## 2. Current evidence

### Runtime version

- Deployed probe checkout `d923a5eb487a17c0a68801bba9ef0f56c81040a8` lacked `runtime.describe`.
- Hermes v0.23.3 exposes `runtime.describe`, including `profile_id`, `instance_id`, `authority_epoch`, and required capabilities.
- `initialize_session_authority` calls `persistence.runtime.begin_epoch` during each Gateway startup. The provider can use `authority_epoch` to distinguish a new Gateway authority from an ordinary WebSocket reconnect.

### Passed live checks on v0.23.3

- Bearer ticket exchange, WebSocket origin and subprotocol authentication, runtime discovery.
- Native session creation, resume, history, and late-turn context.
- Queue admission, snapshot, edit, replacement, and cancellation.
- Active model-turn SIGTERM recovery without duplicate execution.
- Invalid base64 images, stale mutations, unknown sessions, and bad authentication fail closed.

### Failed live check

A model requested a terminal approval. After Gateway SIGKILL and restart:

```json
{
  "execution_state": "running",
  "prompts": []
}
```

The agent remained waiting and the probe timed out after 120 seconds.

Source cause:

- `gateway/session_server_requests.py` stores open requests in process-global `_open`.
- `gateway/session_controls.py` builds `session.resume.prompts` from `server_requests.open_requests`.
- No durable open-request record is restored into `_open` after restart.
- After SIGKILL, Hermes marks the foreign-epoch started admission `unknown`; that admission pauses the session FIFO until `prompt.resolve_unknown` returns a terminal receipt. `session.interrupt` alone does not settle it.
- Canonical `prompt.submit.input_id` becomes the internal admission `request_id`. Hermes persists that ID with the authenticated principal and target session. An exact replay returns the existing admission receipt, including a terminal receipt, without executing the input again; a changed payload fails with `admission_conflict`.

Therefore raw Hermes v0.23.3 cannot meet revision 3's durable open-prompt requirement. The revised contract instead fails the interrupted interaction explicitly, settles the exact admission, and releases later work only after its terminal receipt.

A focused live check passed on 2026-11-20: after a terminal turn vanished from `session.resume.pending`, repeating the exact canonical `input_id` returned the same `admission_id` and terminal receipt, made no second model call, and rejected a changed payload with `admission_conflict`. Evidence: `/tmp/hermes-t3-native-g0/probe-results/exact-retry.json`. This validates the lost-submit-response mechanism, not the complete revised G0 matrix.

A second live check passed: after SIGKILL, two identical `prompt.resolve_unknown` calls returned the identical terminal receipt, the queued follower completed exactly once, and a subsequent prompt completed. Evidence: `/tmp/hermes-t3-native-g0/probe-results/resolve-idempotency.json`. This validates unknown-admission cleanup idempotency, not the complete revised G0 matrix.

A reproducible provider reference guard passed: a stored/current principal mismatch raised `principal_mismatch` before any transport call. This is not a second-principal WebSocket test. Separately, Hermes v0.23.3's admission test proved that replay identity includes principal, session, and request ID. Evidence: `/tmp/hermes-t3-native-g0/probe-results/principal-mismatch.json`.

A fourth live check passed: a genuinely started admission was interrupted with `session.interrupt(session_id, execution_generation)`, reached `interrupted`, released its queued follower once, and allowed a later turn. Repeating the old-generation interrupt returned `stale_generation` without changing that later turn. The initial queued submit receipt had `execution_generation: null`; the probe correctly used the non-null generation from the started receipt. Evidence: `/tmp/hermes-t3-native-g0/probe-results/started-interrupt.json`.

Focused Hermes v0.23.3 tests also passed for immediate approval/clarify, crash and graceful-restart interaction loss, stale-epoch fencing, wrong-profile and stale-instance refusal, request binding, queued/terminal image retention, and compression-segment resume to the logical owner. Evidence and command results are recorded in `/tmp/hermes-native-t3-provider-g0/gate.md`.

## 3. Unchanged architecture

- Implement T3's native `provider-hermes` Gateway in `packages/t3-native-gateway`.
- Use project-local Hermes state and the canonical Webapp/WebSocket transport.
- Hermes owns model execution, session history, tools, skills, memory, cron, and channel behavior.
- T3 owns projects, threads, UI, provider configuration, runtime-mode policy, and delegate orchestration.
- Do not use ACP for the full companion path.
- Preserve T3 `maxRuntimeMode` approval stripping and the whole-instance settings lock.
- Never mutate another provider's configuration or credentials.

## 4. Revised restart contract

### D1. Persist turn, admission, and interaction identity

Before `prompt.submit`, the provider writes a project-local turn record containing the T3 thread and turn identifiers, Hermes `profile_id`, `session_id`, and expected authenticated `principal_id`, a unique canonical `input_id`, and the exact immutable submission payload. It sends that ID as `prompt.submit.input_id`; Hermes stores it as the internal admission `request_id` and exposes it on pending admissions as `input_id`. After submission, the provider durably records the returned `admission_id` before any interaction from that turn becomes answerable. The initial queued submit receipt may have `execution_generation: null`; once execution starts, the provider reads the non-null generation from the started `prompt.receipt` or pending admission and persists it before any interrupt or response.

Before emitting an approval or clarification to T3, the provider writes a pending interaction record containing only:

- T3 thread and turn identifiers.
- Hermes `profile_id`, `session_id`, `principal_id`, `instance_id`, and `authority_epoch`.
- `input_id`, `admission_id`, `prompt_id`, prompt kind, and `execution_generation`.
- Interaction state: `pending`, `recovering`, `resolved`, `recovery_failed`, or `expired`.
- A separate session recovery gate, last terminal receipt when known, provider-local monotonic update revision, and timestamps.

If the accepted submission response was lost before `admission_id` was committed, recovery first tries to join exactly one Hermes pending admission by the persisted `session_id` and unique `input_id`, then commits its `admission_id` before acting. Multiple matches or any identity conflict blocks automatic cleanup.

If no pending match exists and the original submit outcome is unknown, the provider completes the D2 runtime and session identity checks, then repeats the exact `prompt.submit` with the identical `session_id`, `input_id`, payload, and authenticated principal. Hermes's durable admission ledger treats this as an idempotent lookup: an existing admission returns its stored receipt, including a terminal receipt and `admission_id`, without executing the turn again. The provider commits and verifies that receipt. This is the only permitted submit retry. A changed payload, `admission_conflict`, uncertain response, or identity mismatch keeps the session gate closed. No prompt variant or new input ID may be used for recovery.

Do not persist clarify answers, secrets, approval secret choices, or tool output. Approval command metadata remains in the existing protected UI path only. Each write must complete before the corresponding interaction becomes answerable. If a write fails, hold answer actions, keep the session gate closed, and report a recovery-state error.

### D1a. Authenticated principal is part of replay identity

Hermes v0.23.3 has no current-principal RPC. The only supported provider transport therefore has a deployment-level stable-principal guarantee, not an inferred or user-supplied identity:

- The canonical WebSocket accepts only Hermes's `session-token` authentication for T3. Custom login providers, caller-selected subjects, and alternate canonical authentication modes are unsupported.
- The Gateway container has an immutable configured POSIX UID. Hermes maps `session-token` to `host_owner_subject()`, which is exactly `uid:<gateway UID>`; token rotation does not change that principal. A non-POSIX deployment or any deployment that cannot pin and report this UID fails deployment validation.
- The provider configuration records `principal_id = uid:<configured UID>` alongside the endpoint. Session creation and the pre-submit turn record persist that exact value. Before any resume-dependent replay, cleanup, or answer action, the provider compares the current configured principal with the stored principal. A mismatch blocks all mutations and automatic cleanup.
- This guarantee is source-verified, with a live deployment check required before G1 ships. That check must read the admission principal as the pinned `uid:<gateway UID>` before and after token rotation. The provider must not silently derive a principal from a token, OS user running T3, profile path, or session ID.

### D2. Ordinary reconnect preserves the interaction only after identity verification

The provider always calls `runtime.describe` before resume or recovery. It sources `profile_id`, `instance_id`, and `authority_epoch` from that result and requires `profile_id` to match the project record. For same-epoch recovery, `instance_id` and `authority_epoch` must also equal the stored values. Only after those runtime checks and the configured-principal check may it attach with `session.resume`, using the exact stored `session_id`. The provider sources `session_id`, `execution_generation`, and `authority_epoch` from the resumed handle. The combined stored tuple must agree across both RPCs; the provider must not expect `session.resume` to return `profile_id` or `instance_id`. Admission receipts supply their own `ref.profile_id`, `ref.session_id`, `admission_id`, and generation for the remaining checks.

For each pending interaction, the provider verifies the complete identity before reoffering the unchanged prompt. `runtime.describe` supplies profile, instance, and authority epoch; the configured transport record supplies `principal_id`; the local turn record supplies `input_id`; the resumed pending admission supplies `input_id`, `admission_id`, and execution generation; the separate resumed `prompts[]` entry supplies `prompt_id`, prompt kind, and the same execution generation; `prompt.receipt` supplies profile, session, admission ID, status, and generation. `prompt.receipt` does not contain `input_id` or `prompt_id`, so those fields must never be read from it. A terminal admission with no pending row can be checked through the D1 exact-submit lookup and its receipt.

If the prompt is absent, the provider inspects `prompt.receipt`, replayed events, and turn state for an actual resolution. It never assumes absence means denial or approval and never interrupts a same-epoch turn solely because its prompt is absent.

An untracked resumed approval or clarify prompt may be adopted only when its `session_id` and `execution_generation` join exactly one started pending admission and one provider-owned in-flight turn, with the full runtime identity checks above. That admission and the local turn record supply `input_id` and `admission_id`; the prompt itself does not. Otherwise the prompt is quarantined with answer actions disabled and requires explicit user recovery.

Any discovery, resume, receipt, or identity error disables answer actions and new Hermes work for that session. Recovery retries are read-only until identity is certain.

Before identity verification, the only unrestricted RPC is read-only `runtime.describe`. After the runtime identity and configured principal match for the applicable recovery mode, the provider may make exactly one attach with side effects: `session.resume` using the exact stored `session_id`. The parameters `latest`, `title`, `editor`, and `api_key` are forbidden. Resume can refresh policy, open the session, fire hooks, attach a subscription, and follow compression; it is never described as read-only. If the returned `session_id` differs from the stored ID, or the attach fails or is ambiguous, stop recovery, disable answers, and block the session. After a verified attach, `prompt.receipt` and event replay are permitted read-only verification calls. Prompt submission/admission, queued edits, steering, cancellation, interruption, unknown resolution, approval/clarify responses, and every other session mutation remain blocked until identity verification completes. If identity fails after recovery begins, the new-work gate stays closed and all further mutations stop.

### D3. Gateway restart requires terminal admission cleanup

When `authority_epoch` changes, the provider requires the same project `profile_id`, a new `instance_id`, a later epoch, and a resumed handle that agrees with `runtime.describe`. It resumes the exact stored `session_id` and matches any surviving prompt under D2. A missing prompt is never answered.

For a missing prompt, the provider resolves the old admission before releasing any later Hermes work:

1. Join the exact admission by stored `admission_id`, by one D1 unique pending `input_id` match, or by the D1 exact-idempotent submit lookup when the original submit outcome is unknown. Require exactly one verified admission receipt.
2. Call `prompt.receipt` and verify its profile, session, admission ID, and execution generation against the local record. Any mismatch or uncertainty blocks automatic action.
3. If the receipt is `terminal`, persist and report its actual outcome and stored result, if any. Do not overwrite that outcome with a recovery error.
4. If it is `unknown`, call `prompt.resolve_unknown(session_id, admission_id, execution_generation)`. This acknowledges the lost turn; it never sends an approval or clarify response and never requeues the input. Require the returned or subsequently polled receipt to be `terminal`, and report its actual outcome.
5. If it is still `started`, call `session.interrupt(session_id, execution_generation)` for the verified started receipt's session and generation, then poll `prompt.receipt` until that exact admission is `terminal`. The interrupt response is only a session handle, never proof of settlement.
6. A queued or otherwise unexpected admission state does not trigger a guessed action. Keep the session blocked and require explicit user recovery.

Once a nonterminal lost prompt is confirmed, the provider may fail the old T3 turn with `gateway_restart_lost_prompt` to release delegate waits. It must keep a separate per-session new-work gate closed until the old admission has a verified terminal receipt. Prequeued Hermes followers are not considered proof of cleanup; their execution is checked only after the terminal receipt.

Every recovery operation is idempotent. On timeout, disconnect, `stale_generation`, refusal, or uncertain result, the provider reads `prompt.receipt` before retrying the exact same operation. A failed or incomplete cleanup never becomes `resolved`. The old T3 turn remains failed or reports `gateway_restart_recovery_pending`, answer actions stay disabled, and later Hermes work remains blocked. Explicit user recovery may retry or resolve the exact admission, but cannot bypass the terminal-receipt requirement.

Cleanup idempotency is explicit. Repeating `prompt.resolve_unknown` with the same verified session, admission, and generation must return the same terminal receipt without re-executing input. Repeating `session.interrupt(session_id, execution_generation)` for the same session and started-receipt generation must not affect a later generation. After any lost cleanup response, the provider reads the exact admission receipt, adopts an actual terminal outcome, or retries the identical cleanup operation. A started admission is not considered stopped until its receipt is terminal; a bounded timeout leaves the new-work gate closed with `gateway_restart_recovery_pending`.

The terminal error text must say that Hermes restarted while waiting for approval or clarification, whether the old admission was interrupted or reached another actual outcome, and that the original prompt was not re-executed.

### D4. Never synthesize a security decision

Recovery must never convert a missing prompt into `allow`, `deny`, `skip`, or a clarify answer. `session.interrupt` requests turn cancellation, and `prompt.resolve_unknown` settles a lost admission; neither is an approval response.

A denied tool in the live tests must leave its target untouched. A tool approved before a crash may already have run, so any non-idempotent or changed-payload prompt replay is forbidden. Late responses to the old prompt must return `stale_generation` and cannot change the settled result.

### D5. Do not cancel unrelated running turns

Only a provider-owned pending interaction record with a verified changed authority epoch, missing resumed prompt, and exact matching admission triggers automatic recovery. Every interrupt or unknown-resolution call must target the recorded session, admission, and generation.

Stop recovery targets exactly the verified session and execution generation, never the profile or every live session. For the exact lost admission, a `started` receipt requires one interrupt followed by terminal-receipt polling; an `unknown` receipt requires `prompt.resolve_unknown` instead. Recovery must not interrupt an unrelated admission or return success before the target admission is terminal.

A running turn without that record may be normal model execution. Reconnecting or restarting the T3 provider must not cancel it. The provider resumes observation and reports state; only an explicit user action may interrupt it.

### D6. Provider restart and partial writes are covered

Pending turn and interaction records survive a T3 provider restart.

- Same Gateway epoch: apply D2 identity checks before reoffering or adopting an interaction.
- Changed Gateway epoch: apply D3 admission cleanup.
- Provider shutdown alone must not call `session.interrupt`, `prompt.resolve_unknown`, or synthesize an outcome.
- Failure before the pre-submit turn-record commit means no RPC was attempted.
- Failure after the turn-record commit but before the submission response uses the same `input_id`, the D1 pending join, and, when no pending match exists, the D1 exact-idempotent submit lookup. The provider never blindly resubmits or changes the payload.
- Failure after pending-record commit rediscovers the prompt and admission under D2 or D3.
- Failure after an interaction was answered but before local resolution commit uses the Hermes receipt and actual settled outcome; it does not answer again.

### D7. T3 turn completion is separate from session recovery

`gateway_restart_lost_prompt` ends the affected T3 turn as failed and releases any pending delegate wait. `gateway_restart_recovery_pending` means the old turn failed but Hermes cleanup is not yet terminal. Neither state accepts a late answer.

The thread remains visible, but its per-session new-work gate stays closed until D3 obtains the exact terminal receipt. A later user prompt then starts a new turn; it is never treated as an answer to the old interaction. Already queued Hermes followers execute only through Hermes's normal FIFO after the old admission settles, and the provider reports their own receipts exactly once.

## 5. Hermes protocol G0 gate

G0 validates whether stock Hermes v0.23.3 and a small external probe harness support the revised recovery contract. It does not require the T3 provider to exist. Provider-local journaling, UI behavior, delegate release, and provider failure injection are mandatory G3 release tests.

### Gate result and evidence

The Hermes protocol G0 checks are complete. The revised design is ready for final independent review; no provider implementation is authorized until that review passes.

- Runtime discovery, bearer ticket exchange, WebSocket origin and subprotocol authentication, one canonical listener, and the single-profile boundary passed live.
- Session create/resume/history, later-turn context, queued edits, active-turn recovery, and negative request checks passed live.
- Immediate approval deny/approve, immediate clarify, lost approval/clarify after crash and graceful restart, late-response fencing, and no synthesized decisions passed in focused Hermes v0.23.3 tests. Commands and results are in `/tmp/hermes-native-t3-provider-g0/gate.md`.
- Exact terminal submit replay returned the same admission without a second model call and rejected a changed payload with `admission_conflict`. Evidence: `/tmp/hermes-t3-native-g0/probe-results/exact-retry.json`.
- Repeated unknown resolution returned the same terminal receipt, released the queued follower once, and allowed new work. Evidence: `/tmp/hermes-t3-native-g0/probe-results/resolve-idempotency.json`.
- A started admission interrupted with `session.interrupt(session_id, execution_generation)` reached `interrupted`; an old-generation repeat returned `stale_generation` without affecting a later turn. Evidence: `/tmp/hermes-t3-native-g0/probe-results/started-interrupt.json`.
- The principal-mismatch reference guard created no admission or cleanup call. Evidence: `/tmp/hermes-t3-native-g0/probe-results/principal-mismatch.json`. Same-principal cleanup and follower release are evidenced by `/tmp/hermes-t3-native-g0/probe-results/resolve-idempotency.json` above.
- Wrong-profile/stale-instance attach remained read-only and pre-attach submission returned `permission_denied`. Stale-epoch settlement failed closed. Principal, session, request ID, and payload binding passed. Command results are in the gate record.
- Queued and terminal media holders survived staged-image pruning. Both focused retention cases passed.
- Four warm/cold compression-segment resume cases returned the logical owner. The test process printed four passes and then hung during teardown; this is recorded, not hidden. Resuming another owner's segment was refused in a separate passing test.

### Required reference-harness behavior

- Use the exact stored session ID for the sole side-effecting attach. If resume returns a different physical ID, stop without following the redirect or mutating the session. Compression-lineage behavior is verified by Hermes tests; the provider's fail-closed branch is tested in G3.
- Verify the configured `principal_id` before any resume-dependent mutation. A mismatch stops in the provider without sending submit, resolve, interrupt, or answer RPCs. The harness proved this guard; Hermes itself keys admissions by principal and would treat another principal as distinct.
- Treat a queued submit receipt's `execution_generation: null` as incomplete identity. Read and persist the non-null generation from a started receipt or pending admission before interruption or response.
- For an unknown admission, repeat identical `prompt.resolve_unknown` calls until a verified terminal receipt is committed. For a started admission, use the exact `session_id` and `execution_generation`, then poll its receipt. A session handle is never proof of settlement.
- A late approval or clarify response must fail without changing a receipt or queued follower. Recovery never synthesizes an approval, denial, skip, secret, or clarification.
- Keep the reference new-work gate closed until the exact terminal receipt is observed. Then verify both prequeued followers and a new prompt each execute once.

### Provider-only release tests

G3 must inject provider failure before and after the pre-submit journal commit, submit RPC, response commit, pending-interaction commit, answer RPC, and resolution commit. It must also cover delegate release, zero/multiple joins, ambiguous identities, unexpected queued states, already-terminal outcomes, provider restart, and every identity mismatch. These are acceptance requirements for the provider, not evidence that stock Hermes lacks a required RPC.

## 6. Implementation boundaries after G0

Only after revised G0 passes:

- G1: provider registration, project lifecycle, thread/session mapping, WebSocket supervisor. Before G1 ships, run the live pinned-UID principal check before and after token rotation and record it in the deployment evidence.
- G2: event ingestion, prompt admission, queued edits, steering, interruption, receipts.
- G3: approval/clarify UI, persisted pending interactions, restart recovery, images, session mutations, and provider fault-injection tests. These tests cover local journal failures, answer/resolution commit failures, delegate release, new-work gates, principal and identity mismatches, and provider restarts. They are release requirements but cannot run before the provider exists.
- G4: cron, channels, delegation, upgrades, backup/restore, failure injection, and cleanup.

No G1 code begins while G0 is failing or this revision lacks the required council approval.

## 7. Acceptance limits

PR #11 scope amendment: live model and reasoning changes are deferred. T3 submits new turns only with the configured Hermes profile selection and rejects custom selections before any mutation or prompt submission. This does not waive the other G3 release tests or allow G4 to start before G3 passes.

This revision intentionally does not provide seamless recovery of an open approval or clarification across a Hermes Gateway restart. It provides deterministic failure, cleanup, and a usable thread.

If seamless recovery later becomes required, change Hermes to persist and reoffer server requests, then repeat the complete no-degradation G0 gate. Do not describe the revised behavior as durable prompt recovery.
