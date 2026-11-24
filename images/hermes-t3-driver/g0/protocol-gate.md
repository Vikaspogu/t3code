# Hermes native T3 provider protocol G0

Date: 2026-11-21
Runtime: Hermes v0.23.3
Result: PASS for the revised Hermes protocol and external reference-probe contract. Provider implementation and its G3 fault-injection tests have not started.

## Live probes

All commands ran from `/tmp/hermes-t3-native-g0` unless noted.

| Check                                                 | Command                                                                  | Result                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact terminal submit recovery                        | `python3 probe_exact_retry.py`                                           | PASS. Same admission and terminal receipt, no second model call, changed payload rejected with `admission_conflict`. `probe-results/exact-retry.json`                           |
| Unknown cleanup idempotency                           | `python3 probe_resolve_idempotency.py`                                   | PASS. Identical terminal receipts, one follower execution, new work allowed. `probe-results/resolve-idempotency.json`                                                           |
| Started admission interruption                        | `python3 probe_started_interrupt.py`                                     | PASS. Started generation interrupted to terminal, follower and new turn completed, old-generation interrupt returned `stale_generation`. `probe-results/started-interrupt.json` |
| Principal mismatch provider guard                     | `python3 probe_principal_guard.py`                                       | PASS. Mismatch raised before any transport call. This is a reference guard, not a second-principal WebSocket test. `probe-results/principal-mismatch.json`                      |
| Runtime, sessions, queue, restart, negative contracts | `probe_g0.py`, `probe_queue.py`, `probe_restart.py`, `probe_negative.py` | Earlier live results retained under `probe-results/`.                                                                                                                           |

## Focused Hermes v0.23.3 tests

Commands ran from `/tmp/hermes-v0.23.3` with `/tmp/hermes-t3-native-g0/venv/bin/python -m pytest`.

### Immediate and restart interaction matrix

```sh
python -m pytest -q \
  tests/plugins/tools/environments/test_local_environment.py::test_local_approval_denied tests/plugins/tools/environments/test_local_environment.py::test_local_approval_allow_once \
  tests/gateway/test_tool_approval_immediate.py::test_immediate_tool_approval tests/gateway/test_clarify.py::test_clarify_roundtrip \
  tests/gateway/test_crash_recovery_tool_approval.py::test_server_crash_marks_open_tool_approval_interrupted tests/gateway/test_crash_recovery_tool_approval.py::test_late_tool_approval_response_after_server_crash_does_not_overwrite_interruption \
  tests/gateway/test_open_prompt_lifecycle.py::test_graceful_shutdown_marks_open_prompt_interrupted tests/gateway/test_open_prompt_lifecycle.py::test_open_prompt_late_response_does_not_overwrite_interrupted
```

Result: `8 passed`.

```sh
python -m pytest -q \
  tests/gateway/test_open_prompt_lifecycle.py::test_clarify_request_lost_when_gateway_process_killed tests/gateway/test_open_prompt_lifecycle.py::test_pending_clarify_resolved_stale_after_gateway_crash \
  tests/gateway/test_open_prompt_lifecycle.py::test_tool_approval_request_lost_when_gateway_process_killed tests/gateway/test_open_prompt_lifecycle.py::test_pending_tool_approval_resolved_stale_after_gateway_crash \
  tests/gateway/test_open_prompt_lifecycle.py::test_interrupted_prompt_late_response_stays_stale_and_does_not_resolve \
  tests/gateway/test_server_restart_policy.py::test_graceful_restart_keeps_tool_approval_pending
```

Result: `6 passed`.

### Identity and admission fencing

```sh
python -m pytest -q \
  tests/gateway/test_authority_principal.py::test_connection_preserves_server_grant \
  tests/persistence_sqlite/authority/test_runtime_admission.py::test_admission_retry_claim_and_restart_are_fenced
```

Result: `2 passed`. Covers read-only wrong-profile/stale-instance attach, pre-attach `permission_denied`, stale-epoch fencing, principal/session/request binding, and changed-payload conflict.

### Staged image retention

```sh
python -m pytest -q tests/gateway/test_api_media_retention.py::test_api_image_survives_native_cleanup_while_unique_native_bytes_are_collected
```

Result: `2 passed`. Queued and terminal media holders survived; unheld unique bytes were collected.

### Compression lineage

```sh
python -m pytest -vv tests/gateway/test_local_resume_compression_child.py::test_resume_by_a_compression_segment_opens_the_logical_owner
```

Result: all four warm/cold and child-segment cases printed `PASSED`. The process then hung during teardown and the outer 120-second timeout returned 124. This teardown behavior is recorded and is not reported as a clean process exit.

```sh
python -m pytest -q tests/gateway/test_local_resume_compression_child.py::test_a_segment_of_another_owner_stays_refused
```

Result: `1 passed in 11.68s`.

## Scope boundary

The provider's local journal failures, answer/resolution commit failures, delegate release, new-work gates, identity-mismatch branches, and provider restart fault injection are G3 release tests. They require `packages/provider-hermes` to exist and are not evidence of a missing Hermes protocol capability.
