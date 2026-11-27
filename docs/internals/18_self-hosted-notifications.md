# Self-hosted Android notifications

Design and implementation of native Android alerts for agent events, delivered
through a user-operated [ntfy](https://ntfy.sh) server instead of T3 Connect and
Firebase. Opt-in per server environment and per phone, with no cloud account
required. Native alerts are end-to-end encrypted between server and phone.

## Goals and non-goals

Goals:

- Native Android notifications for `approval`, `input`, `failed`, and
  `completed` agent events, deep-linking into the correct thread.
- No T3 Connect account, relay, or Firebase in the delivery path.
- Each server environment decides independently whether to publish. A server
  without configuration changes nothing.
- Native alerts are end-to-end encrypted between the T3 Code server and the
  phone, so the ntfy operator cannot read titles, bodies, or deep links. The
  optional plain-topic fallback sends titles in plaintext.
- Small, contained diff against upstream so a fork can rebase weekly.

Non-goals:

- iOS, web, and desktop notifications (unchanged, out of scope).
- Delivery guarantees. Alerts are ephemeral signals, not a reliable inbox.
- Ongoing "live update" activity cards over the self-hosted path. Only alerts
  are sent; the activity card path still belongs to the relay/Firebase flow.

## Architecture

Two delivery modes share one decision engine on the server:

```
                 NtfyPublisher (decide, dedupe, hold, retry)
                 apps/server/src/notifications/NtfyPublisher.ts
                                |
              +-----------------+------------------+
              | enrollment file absent               | enrollment file present
              v                                      v
   Plain ntfy topic message                 Encrypted UnifiedPush message
   POST {url} {topic,title,message,...}     POST {endpoint} (aes128gcm body)
              |                                      |
              v                                      v
              +---------->  ntfy server  <-----------+
                             |        (topics: relay topic, upXXXXXXXXXXXX)
                             v
                    ntfy Android app (distributor)
                             |
              +--------------+---------------+
              | plain topic                  | UnifiedPush connector topic
              v                              v
   ntfy's own notification        Android broadcast PUSH_EVENT
   (click = t3code:// deep link)             |
                                             v
                            SelfHostedPushService (T3 Code app)
                            decrypt/validate -> AgentNotifications.receive
                                             |
                                             v
                       Native notification: title = thread title,
                       body = "Finished · <project>"
                       tap -> <scheme>://threads/<env>/<thread>
```

The native path is strictly one-way. The server never receives a delivery or
display confirmation; HTTP 2xx from ntfy means "accepted", nothing more.

## Server side

### Configuration (`readConfig` in `NtfyPublisher.ts`)

| Variable                 | Required        | Meaning                                                                                                                                                                                               |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3CODE_NTFY_URL`        | yes (to enable) | ntfy server URL. http/https, no credentials, query, or fragment; a path is allowed. Native delivery matches the enrollment endpoint against this URL's origin. Unset disables the publisher entirely. |
| `T3CODE_NTFY_TOPIC`      | yes             | Plain-text relay topic, used only when no enrollment file exists. `[A-Za-z0-9_-]+`.                                                                                                                   |
| `T3CODE_NTFY_TOKEN_FILE` | yes             | File containing the ntfy bearer token. Trimmed, non-empty.                                                                                                                                            |
| `T3CODE_NTFY_EVENTS`     | no              | Comma-separated subset of `approval,input,failed,completed`. Default all. Unknown values reject the config.                                                                                           |
| `T3CODE_NTFY_UP_FILE`    | no              | Path to the phone enrollment JSON. Presence selects encrypted native delivery.                                                                                                                        |

Any configuration or token-file error logs once and disables the publisher with
no-op `publishThread`/`drain`. The publisher is wired as `NtfyPublisher.layer`
in `apps/server/src/server.ts` and reuses the agent-awareness projection and
publish worker from `apps/server/src/relay/AgentAwarenessRelay.ts`.

### Enrollment file (`NtfyUnifiedPush.ts`)

The file is a single JSON object with exactly five string fields:

```json
{
  "endpoint": "https://ntfy.example.com/upAbCdEfGhIjKl?up=1",
  "p256dh": "<65-byte P-256 public key, unpadded base64url>",
  "auth": "<16-byte auth secret, unpadded base64url>",
  "installationId": "<phone installation UUIDv4>",
  "environmentId": "<this server's environment id>"
}
```

`readUnifiedPushRegistration` validates on every evaluation:

- Opened with `O_NOFOLLOW | O_NONBLOCK`; must be a regular file with no
  group/other permission bits (e.g. `0600` or `0400`), owned by root or the
  server uid, at most 4096 bytes.
- Endpoint must be https, same origin as `T3CODE_NTFY_URL`, path exactly
  `/up` + 12 alphanumerics, query exactly `up=1`.
- `environmentId` must equal the server's own environment id (1–128 chars).
- `p256dh` must be a valid uncompressed P-256 point; `auth` 16 bytes; the
  bearer token shape is rechecked.

Result is `"absent"` (file missing, plain-topic mode), `"invalid"` (native
alerts suppressed with a warning), or a registration plus two derived ids:

- `registrationId = sha256(endpoint \n p256dh \n auth)` — identifies the key
  triple in the payload so the phone can match candidate/active keys.
- `deliveryKey = sha256(registrationId \n installationId)` — keys the server's
  per-destination dedupe state, so rotating phones does not replay or drop
  unrelated alerts. The previous destination's dedupe state is retained for
  rollback (at most two destinations kept).

Removing the file returns the server to plain-topic mode without a restart;
the file is re-read per event.

### Decision engine (`decideNtfyAlert`, `evaluate`)

Events arrive from `threads.streamDomainEvents` (filtered by
`shouldPublishAgentAwarenessEvent`) plus a startup catch-up over active
threads. For each thread:

1. Load the awareness snapshot and skip unlisted lineages. Archived threads
   and deleted projects are skipped and have their dedupe state purged.
2. Project `projectThreadAwarenessV2` and decide:
   - `waiting_for_approval` / `waiting_for_input`: key `wait:<requestId>`.
     `auth_refresh` requests are ignored. Subagent waits are attributed to
     their top-level thread and titled `Subagent needs input/approval`.
   - `completed` / `failed`: key `<kind>:<latestRunId>`. Runs finished before
     server start and snoozed completions are skipped.
   - A `settledOverride === "settled"` thread is re-evaluated without the
     override before giving up.
3. Dedupe on the key per destination, plus a shared `deliveredAlerts` set so
   switching modes cannot double-send.
4. `completed` alerts are held 5 seconds so a quick follow-up state change can
   cancel them.
5. Send. Native alerts also compute `updatedAt` from the triggering request or
   run completion; if the event is older than 120 s
   (`MAX_NATIVE_ALERT_AGE_MS`) it is dropped instead of sent.

Delivery: 10 s timeout (native alerts use the remaining freshness budget,
up to 10 s), retries on network error/429/5xx with backoff
1, 2, 4, 8, 16 s, then the alert is abandoned.
Other statuses (4xx) are rejected permanently. If the enrollment file changes
between decision and
send, the alert is deferred 1 s instead of being sent to stale keys.

### Payload and encryption (`makeUnifiedPushRequest`)

```json
{
  "device_id": "<installationId>",
  "user_id": "self-hosted",
  "environment_id": "<environmentId>",
  "registration_id": "<registrationId>",
  "updated_at": "<epoch millis, string>",
  "alert_id": "sha256(deepLink \n decisionKey)",
  "alert_title": "<thread title, max 120 chars>",
  "alert_body": "<Headline · project title, max 608 chars>",
  "alert_group": "/threads/<env>/<threadId>",
  "alert_path": "/threads/<env>/<threadId>"
}
```

Encrypted with `web-push` (RFC 8291, aes128gcm) to the enrollment keys and
POSTed to the endpoint with the bearer token, `content-encoding: aes128gcm`,
and `ttl` set to the remaining freshness budget in seconds. Ciphertext is
capped at 3072 bytes so even ntfy's base64 form stays under the pinned server's
4 KiB message limit; title/body are truncated by UTF-8 budget without splitting
surrogates. Alerts that cannot fit are dropped as `invalid-native-payload`.

## Phone side (Android)

### Enrollment and registration

UI: `apps/mobile/src/features/settings/SelfHostedNotificationsSettings.tsx`,
per paired environment. JS bridge:
`apps/mobile/src/features/agent-awareness/androidNotifications.ts`
(`configureSelfHostedPush`, `disableSelfHostedPush`,
`removeSelfHostedPush`, `getSelfHostedPushStatus`,
`getSelfHostedPushEnrollment`). Native module:
`apps/mobile/modules/t3-agent-notifications` (`T3AgentNotificationsModule.kt`,
`SelfHostedPush.kt`).

Flow:

1. User installs ntfy, sets its default server to the same origin, and pairs
   the environment in T3 Code.
2. Enabling the toggle calls `SelfHostedPush.configure`, which requires the
   ntfy distributor (`io.heckel.ntfy`) to be installed and either unselected or
   already selected. It stores a per-environment entry (random `instance` id,
   canonical https origin, app scheme) in SharedPreferences
   `t3-self-hosted-push`, then `UnifiedPush.register(instance)`.
3. ntfy calls back `onNewEndpoint` with the endpoint URL and web-push keys.
   The endpoint is canonicalized and must match the configured origin and the
   `/upXXXXXXXXXXXX?up=1` shape. New or changed keys become a `candidate`
   registration with state `needsAcl`.
4. User copies the enrollment JSON (exactly the five fields above) to the
   server's `T3CODE_NTFY_UP_FILE` and grants the ntfy publisher write access to
   the `up…` topic.
5. The first alert that arrives encrypted for the candidate keys promotes
   `candidate` to `active` and marks the environment `verified`.

Per-environment states: `registering`, `needsAcl`, `verified`, `disabled`,
`error`. `verified` requires a nonzero `lastReceivedAt`. Constraints: one ntfy
origin per phone across all environments, at most 32 environments, one
distributor. Disable keeps the registration but cancels the environment's
visible alerts; Reset removes it and unregisters from UnifiedPush. When the
paired-environment catalog is ready, registrations for environments no longer
paired are removed (`reconcileSelfHostedPushEnvironments`). Selecting any
self-hosted environment pauses relay/Firebase registration while it is
selected (existing relay registration state is left in place)
(`selectSelfHostedAgentNotifications` in `remoteRegistration.ts`).

### Receiving an alert (`SelfHostedPush.onMessage`)

The manifest registers `SelfHostedPushService` for
`org.unifiedpush.android.connector.PUSH_EVENT`, so Android can start the app
process for a push even when it is not running. `onMessage`:

1. Requires UnifiedPush-decrypted content of 1–3993 bytes, an enabled,
   selected registration.
2. Strict UTF-8 decode; JSON object of at most 24 string-valued fields; only
   the ten alert fields are used.
3. `environment_id`, `device_id`, and `user_id` must match the binding and
   installation. `alert_path` must be `/threads/<env>/<id>` with a single
   clean path segment. `alert_id` 1–512 chars; title 1–120; body 1–608.
4. `registration_id` must match the candidate or active key triple.
5. Hands off to `AgentNotifications.receive(..., selfHosted = true)`, which
   re-checks identity, notification permission, and freshness
   (`MAX_SELF_HOSTED_MESSAGE_AGE_MS = 120 s` around `updated_at`).
6. On success promotes a candidate registration and records `lastReceivedAt`.

`lastReceivedAt` therefore proves the pipeline delivered a valid alert. It
does not prove a banner was shown (see suppression below).

### Display (`AgentNotifications.kt`, shared with the relay path)

- Channel `agent-alerts` (IMPORTANCE_HIGH), grouped per thread with an inbox
  summary when more than one alert is visible for the group.
- `alert_id` (namespaced by environment) dedupes against the last 64 alerts,
  so retries cannot resurface an alert.
- On-screen suppression: if the app is resumed and the alert's `alert_path`
  equals the thread currently on screen (`setThreadOnScreen`), no banner is
  posted, but the id is still consumed and `lastReceivedAt` still advances.
- Tapping opens `<scheme>://threads/<env>/<threadId>` via the launch intent
  (CLEAR_TOP | SINGLE_TOP). Paths with query or fragment fall back to `/`.
- Disabling the last self-hosted environment clears the shared notification
  store and visible alerts.

## ntfy and UnifiedPush

ntfy is only a transport. For native alerts it must:

- Accept the publisher's POST to `/upXXXXXXXXXXXX?up=1` with the bearer token
  and the `X-UnifiedPush-Version: 2` semantics (the T3 Code app sends `up=1`;
  ntfy treats the message as UnifiedPush and does not render it itself).
- Hold the message in the topic cache until the phone's ntfy app collects it,
  honoring the TTL. Expired messages are silently discarded.
- Forward it to the ntfy Android app over its persistent connection; the app
  then broadcasts the bytes to T3 Code.

ACLs: the publisher account needs write-only access to the plain relay topic
and to each phone's `up…` topic. The phone's ntfy account needs read access.
No other account should be able to read the relay topic if plaintext mode is
used, since it contains thread and project titles.

The ntfy Android app must be able to keep its connection alive: battery
optimization disabled and the Alarm & Reminders permission granted. Otherwise
the connection flaps, and because alerts carry a ~120 s TTL, they expire in
the cache before delivery.

## Operational runbook

Server (systemd example):

```ini
Environment=T3CODE_NTFY_URL=https://ntfy.example.com
Environment=T3CODE_NTFY_TOPIC=t3code-my-server
Environment=T3CODE_NTFY_TOKEN_FILE=/home/agent/.t3/secrets/ntfy-token
Environment=T3CODE_NTFY_EVENTS=approval,input,failed,completed
Environment=T3CODE_NTFY_UP_FILE=/home/agent/.t3/secrets/ntfy-up.json
```

The enrollment file must be owner-only (no group/other permission bits;
`0600` recommended), owned by the service user (or root),
a regular file, not a symlink. Invalid content suppresses native alerts by
design; check logs for `ntfy native push configuration invalid`.

Setup order: pair and enable on the phone, copy the enrollment JSON to the
server, add the `up…` ACL grant, restart the server if `T3CODE_NTFY_UP_FILE`
was just added. When rotating phones or keys, replace the file with the
candidate enrollment so the server can encrypt for it, and keep the previous
ACL grant until the candidate verifies. The server retains the previous
destination's dedupe state so rolling back does not replay alerts.

Verification and troubleshooting:

- Settings shows `Verified` and a received time only after a valid alert was
  processed, including alerts suppressed because their thread was on screen.
- ntfy returning 200 means accepted, not displayed.
- Missing alerts: check the ntfy app's subscription state (`reconnecting…`
  means the battery/alarm fix is needed), then the publisher's ACL on the
  `up…` topic. ACL changes in a secret manager require syncing the secret and
  restarting the ntfy pod; environment variables are read at process start.
- Alerts for the thread you are viewing never show a banner. Test from a
  different screen.

## Security notes

- Plain-topic mode exposes thread and project titles to the ntfy server and
  anyone who can read the topic. Native mode exposes only the topic name and
  timing; content is aes128gcm-encrypted with keys that never leave the phone
  except through the out-of-band enrollment copy.
- The enrollment file contains decryption keys and is handled like a private
  key: strict file checks on the server, `Redacted` token handling, no logging
  of contents.
- The server validates endpoint origin and shape to avoid publishing
  ciphertext to an attacker-controlled URL, and binds the file to its own
  environment id.
- The receiver authenticates payloads by environment, installation,
  registration id, field shapes, and freshness before displaying anything.
- The server cannot detect a dead phone, revoked token, or deleted topic; it
  publishes with a short TTL and stops.

## Limits and tradeoffs

- Best-effort delivery. A publish that succeeds at ntfy but times out at the
  server can be retried and delivered twice; the phone's alert-id dedupe hides
  the repeat. Total retry budget is ~31 s plus timeouts, and native alerts
  older than 120 s are dropped on both ends.
- One alert per dedupe key, and a shared delivered set suppresses re-sending
  an already-delivered alert even to a new destination. 32 recent keys are
  retained per thread, plus live subagent waits.
- Sends are sequential across threads; a slow ntfy server can delay other
  alerts by up to 10 s each.
- No delivery receipts, no badge counts, no ongoing activity card on the
  self-hosted path.
- Android only; requires the ntfy app as UnifiedPush distributor and a
  reachable self-hosted ntfy server.

## Testing

- `apps/server/src/notifications/NtfyPublisher.test.ts`: config parsing,
  decision/dedupe/hold/retry behavior, enrollment validation, payload budgets,
  rotation and rollback.
- `apps/mobile/modules/t3-agent-notifications/android/src/test/.../SelfHostedPushTest.kt`
  and `AgentNotificationsTest.kt`: registration state machine, endpoint and
  payload validation, dedupe, suppression.
- `apps/mobile/src/features/agent-awareness/androidNotifications.test.ts`:
  bridge decoding, enrollment shape checks, environment reconciliation.
- End-to-end: enable on a real phone, trigger each event kind, and confirm
  native alerts and deep links. Scripted pushes through the real ntfy server
  can isolate transport problems from server decision problems.

## Fork maintenance

The feature is contained in a small set of files so weekly upstream rebases
stay cheap:

- Added, upstream never touches: `apps/server/src/notifications/`,
  `SelfHostedPush.kt`, `SelfHostedNotificationsSettings.tsx`, their tests.
- Small edits in shared files: `apps/server/src/server.ts` (import + layer),
  `AgentNotifications.kt` (self-hosted freshness, receive/showAlert hooks),
  `T3AgentNotificationsModule.kt` (five bridge functions),
  `androidNotifications.ts` (self-hosted bridge section),
  `AndroidManifest.xml` (service + permissions), `remoteRegistration.ts`
  (self-hosted selection), Settings screen (section entry), translations.
