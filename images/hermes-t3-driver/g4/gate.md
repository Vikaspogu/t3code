# G4 operational gate

Result: pass for the disposable deployment scope. Scheduled cron, loopback channel delivery, delegation, crash recovery, explicit operator discard, and pre-staged version switching with restore were verified. The limits below apply to release.

Hermes v0.23.3: `caafe5389ae585ef77387a962aee05b1bcf17029`. T3: PR #11 local worktree, based on `9ccc4103b5` with the G2/G3 changes applied. No production credentials, endpoints, or deployments were used.

## Observed

- Loopback Hermes Jobs API and real script-only scheduler: unauthenticated list returned 401. One job completed and one failed, with exactly one execution per job. A second tick ran nothing. Both jobs were deleted from the test instance.
- Real Hermes backup and import into a new disposable home preserved both job IDs and both execution IDs. The restored scheduler did not rerun either job. Service revival was suppressed in the probe to avoid starting a host service.
- Pinned upstream pytest batches: Jobs API (26), ambiguous delivery / duplicate prevention (13), backup interruption and staging cleanup (22), backup retention and session-store round trip (2), update notifications and recovery (21), channel attribution and single-writer delivery (15), dashboard job history and isolation (64), cron receipt recovery and failure bookkeeping (16). All listed batches exited 0. Channel and update tests exercise their fixtures, not a real external channel or a version upgrade.
- The T3 G3 delegate-release regression verifies orchestration routing and parent continuation from a simulated Hermes failure event. It is not a live T3/Hermes deployment test.
- A real scheduler fired a due job without a manual API trigger. The stock Mattermost adapter authenticated with a synthetic token and sent `G4_DUE_DELIVERY` to a loopback Mattermost-compatible sink. Job `a72336e2db3b` had one execution, `c1f9bcc1fc1c45d0af75e120e51f56a1`, with `source=builtin`, `status=completed`, and `delivery_outcome=delivered`. Commands and receipts: `/tmp/hermes-g4-due.EAVgLZ/REPORT.md`. This does not validate a real Mattermost service.
- Disposable T3 and the stock Gateway completed one text turn and persisted `G4 synthetic response`. T3 used an in-memory load hook to set the provider's existing test-only turn opt-in. The normal built-in driver refused turns as expected. The model peer was synthetic and loopback-only.

## Reproduce in the disposable runtime

The smoke script and virtual environment are local evidence in `/tmp/hermes-g4.uyllgp` and may not survive a workspace restart. Run from the pinned Hermes checkout:

```sh
root=/tmp/hermes-g4.uyllgp
src=/tmp/hermes-v0.23.3-g3-review
state=$(mktemp -d "$root/cron-state.XXXXXX")
cd "$src"
test "$(git rev-parse HEAD)" = caafe5389ae585ef77387a962aee05b1bcf17029 || exit 1
env -i PATH="$root/venv/bin:/usr/bin:/bin" HOME="$root/home" \
  HERMES_HOME="$state" TMPDIR="$root/tmp" HERMES_DISABLE_LAZY_INSTALLS=1 \
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$src" \
  "$root/venv/bin/python" "$root/probe_cron.py"
```

Output: `cron archive restore: 2 jobs, original execution IDs, no duplicate runs` and `{"unauthenticated_status": 401, "jobs": {"success": 1, "failure": 1}, "duplicate_runs": 0, "jobs_after_cleanup": 0}`.

The pytest command in the same isolated setup was `python -m pytest -p no:cacheprovider -q` with these paths, run in separate batches:

```text
tests/gateway/test_api_server_jobs.py
tests/cron/test_cron_standalone_no_duplicate_replay.py
tests/hermes_cli/test_backup_staging_recovery.py
tests/hermes_cli/test_backup_retention_roundtrip.py
tests/gateway/test_update_command.py
tests/cron/test_cron_bot_chat_delivery.py
tests/hermes_cli/test_web_server_cron_profiles.py
tests/cron/test_cron_recovery.py tests/cron/test_canonical_receipt_bookkeeping.py tests/cron/test_cron_journal_terminal_exits.py
```

## Process-loss results

- T3 SIGKILL with an ordinary admitted turn in progress and restart continuation enabled: the original run was cancelled. T3 created three continuation runs and all failed. The model saw the original prompt once. This case had no pending interaction and did not exercise same-run interaction recovery.
- Gateway SIGKILL with T3 kept alive: the same profile came back with a new instance and authority epoch `1` → `2`. The old turn failed, with one model invocation. The provider journal retained `queued` with no execution generation, while the matching Gateway admission was `unknown` with generation `1`. A new user message on that same thread failed, and the old admission was still unresolved after the attempt.
- Receipt-promotion rerun (`bash /tmp/t3-hermes-g4.RDRIGP/rerun-promotion.sh`): before SIGKILL both the provider journal and Gateway showed `started`, generation `1`. After the Gateway restarted at epoch `6`, T3 failed the old turn and the corresponding Gateway admission remained `unknown`. The fixture recorded one model invocation. This proves receipt promotion works on the real wire, but the ordinary-turn recovery gate still did not settle the old admission. The script stopped its disposable services.
- Live clarification recovery passed with the test-only `clarify` toolset override: `bash /tmp/t3-hermes-g4.RDRIGP/rerun-clarify.sh g4-clarify-reconnect-503`. One real clarification appeared before SIGKILL. After the epoch moved `14` → `15`, the original admission became terminal, the old card expired, and a new turn on the same thread completed. This does not exercise a T3 process crash with an open clarification.
- A disposable trace found that the replacement Gateway's socket-ticket endpoint returned HTTP 503 while booting. The provider now bounds connection retry to 15 seconds and checks identity after connecting. Only HTTP 503 or connection refused is retryable. It does not retry authorization failures or send any turn or cleanup RPC during the wait.
- T3-only SIGKILL with a real pending clarification failed (`bash /tmp/t3-hermes-g4.RDRIGP/rerun-t3-clarify.sh`). The Gateway stayed on epoch `16`; the original admission was started with generation `1` before the crash. On the replacement T3 process, the answer was rejected with `Hermes resume refused; restart required.` No successful same-run recovery is claimed.
- T3-only crash rerun passed after fixing event order: `bash /tmp/t3-hermes-g4.RDRIGP/rerun-t3-clarify.sh g4-clarify-t3-validated-order`. The same Gateway stayed on epoch `22`. The original clarification was reoffered live, the answer completed the original run, and the only admission moved from started to terminal at generation `1`. All disposable listeners stopped. The focused provider regression fails if the request is emitted before its owning turn.
- Evidence: `python3 /tmp/t3-hermes-g4.RDRIGP/check-results.py` checks the synthetic T3 and Hermes SQLite rows and model invocation counts. The same directory has `drive.py`, `fixture.py`, `enable-turns.mjs`, `restart-t3.sh`, and `restart-gateway.sh`. The three loopback listeners were stopped after evidence collection. Do not reuse these scripts against a non-disposable service.

## Version lifecycle results

- Disposable source moved from Hermes v0.23.2 to v0.23.3, but `hermes update` timed out after 120 seconds. The updater unexpectedly started an isolated dependency install despite the no-install constraint. Its processes were stopped.
- Rollback to v0.23.2 and stock backup import restored the synthetic cron job and marker. The restored foreground Gateway did not become ready within 10 seconds, so service revival was not verified. No host service was changed.
- Commands and logs: `/tmp/hermes-g4-version.6X0Z6m/report.md`.
- The foreground restore rerun passed with explicit loopback API-server configuration. v0.23.2 served the restored job via authenticated `/api/jobs` (HTTP 200), refused an anonymous request (401), and stopped cleanly. A pre-staged v0.23.3 Gateway served the same job from a copied restored home. Commands: `bash /tmp/hermes-g4-revival.r2ooxd/run_restore.sh` and `bash /tmp/hermes-g4-revival.r2ooxd/run_prestaged_v0233.sh`. See `/tmp/hermes-g4-revival.r2ooxd/REPORT.md`. The pre-staged switch does not establish that `hermes update` completes.

## Operator recovery, delegation, and limits

- An ordinary turn still stays fenced after reconnect: `gateway_restart_recovery_pending: no exact lost Hermes prompt and admission`. The Gateway admission stays `unknown` until explicitly settled. D5 does not automatically interrupt or resolve this case.
- Operator recovery passed with T3 kept live: `bash /tmp/t3-hermes-g4.RDRIGP/rerun-operator-discard.sh` (exit 0, `operator-discard-final.log`). After Gateway SIGKILL and epoch `32` → `33`, T3 failed the original run and refused new work. The stock `hermes sessions discard <session> --admission <id> --yes` command settled the original admission at generation `1`. The next run on the same T3 thread completed. The original model was invoked once. If T3 itself restarts before this reconciliation, the thread stays fenced. All disposable listeners stopped.
- Live delegation passed: `bash /tmp/t3-hermes-g4-delegate.V1becx/run-delegate.sh` (exit 0, `parent-rerun-output.log`). T3 dispatched a real Hermes child that reached a pending clarification. After Gateway SIGKILL and epoch `25` → `26`, the child and its delegated task failed with `gateway_restart_lost_prompt`, the original parent run stayed completed, and the parent wake completed. The child's single admission was terminal at generation `1` in both journals, with one child model invocation. This used loopback fixtures and the test-only turn opt-in. All disposable listeners stopped.
- Upgrade via a pre-staged version switch, rollback, backup import and foreground revival are verified for this fixture. The in-place updater remains unverified. Channel coverage is limited to a compatible loopback sink.
- If T3 needs full cron history, agree on an authorized read path first. The Hermes Jobs API returns latest job state and uses the general API bearer. Full history is a separate dashboard route. Neither check authorizes giving T3 the general API bearer or exposing the dashboard.
- No production cutover is part of this gate.
