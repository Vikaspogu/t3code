# Updating installed T3 Code surfaces

How to move each installed surface of this fork onto a new `orbit-v*` release. Releases are published by the `release-orbit` workflow whenever an `orbit-v<upstream>-orbit.<N>` tag is pushed; every release carries the CLI archive, the macOS DMG, and the Android APK. Check the [releases page](https://github.com/Vikaspogu/t3code/releases) for the newest tag.

## macOS desktop app

Updates are delivered in-app. The app checks the fork's `latest-mac.yml` feed, downloads the update package referenced by the feed, and applies it on restart — no manual steps for a normal release. Builds are signed with the `T3 Orbit (Self-Signed)` identity (`T3_ORBIT_CSC_*` secrets); Squirrel.Mac only accepts updates signed with the same identity as the installed app.

A fresh DMG install is needed once, to move off any build that predates `orbit-v0.1.2-orbit.6` (ad-hoc signed; Squirrel rejects the identity change):

1. Download the DMG and its `.sha256` from the release and verify: `shasum -a 256 -c <dmg>.sha256`.
2. Mount the DMG and copy the app to `~/Applications` (`ditto "/Volumes/<dmg>/<App>.app" ~/Applications/`), replacing any same-named app.
3. On first launch Gatekeeper prompts about an unidentified developer — right-click → Open, once per machine.
4. User data is shared across app bundles (`~/Library/Application Support/t3code-v2`), so connections and projects carry over. Delete the old app once the new one is confirmed working.

## VM (headless server)

The server self-updates its launcher but keeps the running service on its current version until you restart it, because a restart interrupts agent turns, terminals, and remote clients connected to that server.

```sh
t3 update            # downloads the newest release and switches the launcher
t3 service restart   # switches the background service; run when nothing important is in flight
```

Verify with `t3 --version`, `systemctl --user is-active t3code.service`, and confirm the port is listening. The service unit name is `t3code.service` (user-level systemd). Over plain SSH `t3 update` refuses to restart the service non-interactively; `t3 service restart` is the explicit switch.

## Android phone

The release carries an arm64 APK. A store-less updater such as Obtainium tracks the fork's releases page and installs the APK on each new tag. Releases since `orbit-v0.1.2-orbit.6` are stamped with the release version, so Obtainium detects them correctly.
