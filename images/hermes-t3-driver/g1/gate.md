# G1: pinned admission principal across token rotation

Date: 2026-07-15
Runtime: Hermes v0.23.3, isolated `/tmp/hermes-t3-native-g0`, external-supervisor deployment
Result: PASS

Command:

```sh
/tmp/hermes-t3-native-g0/venv/bin/python /tmp/hermes-t3-native-g0/probe_token_rotation.py
```

The probe held model completion, restarted the Gateway with one fresh session token, resumed an admission, then repeated the process with a second fresh token. The two live admission records both returned `principal_id: "uid:0"`, matching the pinned Gateway POSIX UID. No admission was marked terminal by the probe.

Provider configuration binds `HERMES_SESSION_TOKEN` to `HERMES_GATEWAY_URL`, which must exactly match the provider instance endpoint. `HERMES_STATE_DIR` must be absolute and outside the workspace so a repository cannot supply session mappings. Cleartext `ws:` requires the explicit `HERMES_ALLOW_CLEARTEXT=1` deployment opt-in.
Result file: `/tmp/hermes-t3-native-g0/probe-results/token-rotation.json`.

The report contains session IDs, principal IDs, process IDs, timestamps, and `passed: true`. It does not contain either token. No production token, Home Ops configuration, or managed service was accessed.

This validates only the principal transport guarantee required by G1. It does not establish G2 crash/journey recovery or production readiness.
