// @effect-diagnostics nodeBuiltinImport:off -- Executes workflow shell steps against a local fake gh executable.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

it("declares the UnifiedPush connector service action", () => {
  const manifest = NodeFS.readFileSync(
    new URL(
      "../apps/mobile/modules/t3-agent-notifications/android/src/main/AndroidManifest.xml",
      import.meta.url,
    ),
    "utf8",
  );
  expect(manifest).toContain('android:name="org.unifiedpush.android.connector.PUSH_EVENT"');
});

const Job = Schema.Struct({
  if: Schema.optional(Schema.String),
  steps: Schema.Array(Schema.Struct({ name: Schema.String, run: Schema.optional(Schema.String) })),
});
const workflow = Schema.decodeSync(
  fromYaml(
    Schema.Struct({
      on: Schema.Struct({
        workflow_dispatch: Schema.Struct({
          inputs: Schema.Struct({
            android_only: Schema.optional(
              Schema.Struct({ type: Schema.String, default: Schema.Boolean }),
            ),
          }),
        }),
      }),
      jobs: Schema.Struct({ release: Job, cli: Job, android: Job, macos: Job, publish: Job }),
    }),
  ),
)(NodeFS.readFileSync(new URL("../.github/workflows/release-orbit.yaml", import.meta.url), "utf8"));
const decodeCall = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

function shellStep(
  job: "release" | "publish",
  name: string,
  existing = "none",
  androidOnly = true,
) {
  const script = workflow.jobs[job].steps.find((step) => step.name === name)?.run;
  if (!script) throw new Error(`Missing workflow step: ${name}`);
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-android-release-"));
  try {
    const log = NodePath.join(directory, "calls.jsonl");
    NodeFS.writeFileSync(
      NodePath.join(directory, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  if (args.includes("POST")) process.exit(0);
  const resource = args.at(-1);
  const kind = process.env.EXISTING_KIND;
  const exists = (kind === "tag" && resource.includes("/git/ref/")) ||
    (kind === "release" && resource.includes("/releases/tags/")) ||
    (kind === "full" && resource.includes("/orbit-v"));
  process.stdout.write("HTTP/2.0 " + (exists ? "200 OK" : kind === "api-error" ? "500 Server Error" : "404 Not Found") + "\\r\\n\\r\\n{}");
  process.exit(exists ? 0 : 1);
}
if (args[0] === "release" && args[1] === "view") process.exit(1);
`,
      { mode: 0o700 },
    );
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", script.replaceAll("${{ steps.meta.outputs.version }}", "1.2.3-native.1")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GH_LOG: log,
          GH_REPO: "owner/repo",
          GITHUB_SHA: "tested-head",
          VERSION: "1.2.3-native.1",
          RELEASE_TAG: `${androidOnly ? "android-native" : "orbit"}-v1.2.3-native.1`,
          ANDROID_ONLY: String(androidOnly),
          EXISTING_KIND: existing,
        },
      },
    );
    const calls = NodeFS.existsSync(log)
      ? NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => decodeCall(line))
      : [];
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

function apkUpgradeCheck(
  input: {
    packageName?: string;
    versionCode?: string;
    certificate?: string;
    unsigned?: boolean;
  } = {},
) {
  const script = workflow.jobs.android.steps.find(
    (step) => step.name === "Verify APK upgrade identity",
  )?.run;
  if (!script) throw new Error("Missing APK upgrade identity gate");
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-apk-upgrade-"));
  try {
    const buildTools = NodePath.join(directory, "build-tools", "36.0.0");
    NodeFS.mkdirSync(buildTools, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(directory, "release-android"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "release-android", "t3-test-android-arm64.apk"),
      "candidate",
    );
    NodeFS.writeFileSync(
      NodePath.join(directory, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(args[args.indexOf("--dir") + 1], "baseline-android-arm64.apk"), "baseline");
`,
      { mode: 0o700 },
    );
    NodeFS.writeFileSync(
      NodePath.join(buildTools, "apksigner"),
      `#!/usr/bin/env node
const baseline = process.argv.at(-1).endsWith("baseline-android-arm64.apk");
if (!baseline && process.env.FAKE_UNSIGNED === "1") process.exit(1);
console.log("Signer #1 certificate SHA-256 digest: " + (baseline ? "a".repeat(64) : process.env.FAKE_CERTIFICATE));
`,
      { mode: 0o700 },
    );
    NodeFS.writeFileSync(
      NodePath.join(buildTools, "aapt"),
      `#!/usr/bin/env node
const baseline = process.argv.at(-1).endsWith("baseline-android-arm64.apk");
console.log("package: name='" + (baseline ? "com.t3tools.t3code" : process.env.FAKE_PACKAGE) + "' versionCode='" + (baseline ? "123" : process.env.FAKE_VERSION) + "' versionName='1.0'");
`,
      { mode: 0o700 },
    );
    return NodeChildProcess.spawnSync("bash", ["-c", script], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        ANDROID_HOME: directory,
        GITHUB_WORKSPACE: directory,
        RUNNER_TEMP: directory,
        GH_REPO: "owner/repo",
        VERSION: "test",
        FAKE_PACKAGE: input.packageName ?? "com.t3tools.t3code",
        FAKE_VERSION: input.versionCode ?? "124",
        FAKE_CERTIFICATE: input.certificate ?? "a".repeat(64),
        FAKE_UNSIGNED: input.unsigned ? "1" : "0",
      },
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

it("accepts only an APK that upgrades the prior Orbit package and signing identity", () => {
  expect(apkUpgradeCheck().status).toBe(0);
});

it.each([
  { name: "another application ID", input: { packageName: "com.t3tools.t3code.dev" } },
  { name: "another signing key", input: { certificate: "b".repeat(64) } },
  { name: "an unsigned APK", input: { unsigned: true } },
  { name: "the same version code", input: { versionCode: "123" } },
  { name: "a lower version code", input: { versionCode: "122" } },
  { name: "a malformed version code", input: { versionCode: "not-a-number" } },
])("rejects $name before APK upload", ({ input }) => {
  expect(apkUpgradeCheck(input).status).not.toBe(0);
});

function publishAllowed(androidOnly: boolean, android = "success", cli?: string, macos?: string) {
  const condition = workflow.jobs.publish.if;
  if (!condition) throw new Error("Missing publication condition");
  return NodeVM.runInNewContext(condition.replace(/^\s*\$\{\{|\}\}\s*$/g, ""), {
    always: () => true,
    cancelled: () => false,
    github: { server_url: "https://github.com" },
    needs: {
      release: { result: "success", outputs: { android_only: String(androidOnly) } },
      android: { result: android },
      cli: { result: cli ?? (androidOnly ? "skipped" : "success") },
      macos: { result: macos ?? (androidOnly ? "skipped" : "success") },
    },
  }) as unknown;
}

it("keeps Android-only mode explicitly opt-in", () => {
  expect(workflow.on.workflow_dispatch.inputs.android_only).toEqual({
    type: "boolean",
    default: false,
  });
});

it("creates a fresh Android-only draft as prerelease and not latest", () => {
  const result = shellStep("release", "Create release if missing");
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.find((call) => call[0] === "release" && call[1] === "create")).toEqual(
    expect.arrayContaining([
      "android-native-v1.2.3-native.1",
      "--draft",
      "--prerelease",
      "--latest=false",
    ]),
  );
  expect(result.calls.some((call) => call.includes("delete") || call.includes("edit"))).toBe(false);
});

it.each(["tag", "release", "api-error"])(
  "refuses native release creation on %s without changing an existing release",
  (existing) => {
    const result = shellStep("release", "Create release if missing", existing);
    expect(result.status).not.toBe(0);
    expect(result.calls.every((call) => call[0] === "api")).toBe(true);
  },
);

it("does not inspect, delete or replace a full Orbit release with the same version", () => {
  const result = shellStep("release", "Create release if missing", "full");
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.flat().some((arg) => arg.includes("orbit-v"))).toBe(false);
});

it("publishes an Android-only release with explicit prerelease and not-latest flags", () => {
  const result = shellStep("publish", "Publish draft release");
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toEqual([
    [
      "release",
      "edit",
      "android-native-v1.2.3-native.1",
      "--draft=false",
      "--prerelease",
      "--latest=false",
    ],
  ]);
});

it("retains the normal full-release creation and publication path", () => {
  const created = shellStep("release", "Create release if missing", "none", false);
  expect(created.status, created.stderr).toBe(0);
  expect(created.calls.at(-1)).toEqual(
    expect.arrayContaining(["create", "orbit-v1.2.3-native.1", "--draft"]),
  );
  expect(created.calls.at(-1)).not.toContain("--prerelease");
  const published = shellStep("publish", "Publish draft release", "none", false);
  expect(published.calls).toEqual([["release", "edit", "orbit-v1.2.3-native.1", "--draft=false"]]);
});

it("allows Android-only publication with successful Android and skipped other surfaces", () => {
  expect(publishAllowed(true)).toBe(true);
  expect(publishAllowed(false)).toBe(true);
});

it.each(["failure", "cancelled", "skipped"])("blocks publication after Android %s", (result) => {
  expect(publishAllowed(true, result)).toBe(false);
  expect(publishAllowed(false, result)).toBe(false);
});

it.each(["failure", "cancelled", "skipped"])(
  "retains the full-release desktop and CLI gates on %s",
  (result) => {
    expect(publishAllowed(false, "success", result)).toBe(false);
    expect(publishAllowed(false, "success", "success", result)).toBe(false);
  },
);

it("runs the real native unit-test task before standalone packaging and signing", () => {
  const steps = workflow.jobs.android.steps;
  const unit = steps.findIndex((step) =>
    step.run?.includes(":t3-agent-notifications:testReleaseUnitTest"),
  );
  const build = steps.findIndex((step) => step.run?.includes("assembleRelease"));
  const sign = steps.findIndex((step) => step.name === "Sign APK");
  expect(unit).toBeGreaterThanOrEqual(0);
  expect(build).toBeGreaterThan(unit);
  expect(sign).toBeGreaterThan(build);
  const verify = steps.findIndex((step) => step.name === "Verify APK upgrade identity");
  const upload = steps.findIndex((step) => step.name === "Upload APK");
  expect(verify).toBeGreaterThan(sign);
  expect(upload).toBeGreaterThan(verify);
});
