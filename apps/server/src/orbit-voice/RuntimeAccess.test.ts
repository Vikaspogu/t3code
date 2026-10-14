import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as RuntimeAccess from "./RuntimeAccess.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);
const id = ProviderInstanceId.make("voice-personal");
const peerId = ProviderInstanceId.make("voice-peer");
const settings = Schema.decodeUnknownSync(CodexSettings)({
  binaryPath: "/captured/codex",
  homePath: "/captured/home",
});
const captured = { settings, environment: { CAPTURED: "yes" } };
const instance = (instanceId = id, auth?: ProviderInstance["auth"]): ProviderInstance => ({
  instanceId,
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
  displayName: "Fixture",
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: "fixture",
  },
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
  ...(auth ? { auth } : {}),
});
const registry = (instances: ReadonlyArray<ProviderInstance>) =>
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instances.find((entry) => entry.instanceId === instanceId)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });

it.effect("uses the adapter's captured runtime without reading newer settings", () =>
  Effect.gen(function* () {
    const access = yield* RuntimeAccess.RuntimeAccess;
    yield* access.register(id, captured);
    const runtime = yield* access.use(id, Effect.succeed);
    assert.strictEqual(runtime.config, settings);
    assert.strictEqual(runtime.environment, captured.environment);
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, registry([instance()])))),
);

it.effect("an old registration finalizer cannot remove its replacement", () =>
  Effect.gen(function* () {
    const access = yield* RuntimeAccess.RuntimeAccess;
    const old = yield* Scope.make();
    yield* access.register(id, captured).pipe(Effect.provideService(Scope.Scope, old));
    const replacement = { ...captured, environment: { CAPTURED: "replacement" } };
    yield* access.register(id, replacement);
    yield* Scope.close(old, Exit.void);
    assert.strictEqual(
      (yield* access.use(id, Effect.succeed)).environment,
      replacement.environment,
    );
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, registry([instance()])))),
);

it.effect("a credential peer changing blocks runtime resolution before spawn", () =>
  Effect.gen(function* () {
    const binding = { owner: "provider" as const, key: "shared-voice" };
    const auth = yield* ProviderAuthFlow.make({
      instanceId: id,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const related = [
      instance(id, auth),
      instance(peerId, { ...auth, isChangingCredentials: Effect.succeed(true) }),
    ];
    const access = yield* RuntimeAccess.RuntimeAccess;
    let entered = false;
    yield* access.register(id, {
      ...captured,
      resolveRuntime: Effect.sync(() => {
        entered = true;
        return { config: settings, environment: {}, revision: "fixture" };
      }),
    });
    const result = yield* access
      .use(id, Effect.succeed)
      .pipe(Effect.provide(registry(related)), Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(entered);
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, NodeServices.layer))),
);

it.effect("shared managed signout interrupts voice startup and releases its resources", () =>
  Effect.gen(function* () {
    const binding = { owner: "provider" as const, key: "shared-voice" };
    const auth = yield* ProviderAuthFlow.make({
      instanceId: id,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const peerAuth = yield* ProviderAuthFlow.make({
      instanceId: peerId,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const access = yield* RuntimeAccess.RuntimeAccess;
    yield* access.register(id, captured);
    const startup = yield* access
      .use(id, () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      )
      .pipe(
        Effect.provide(registry([instance(id, auth), instance(peerId, peerAuth)])),
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    yield* peerAuth.logout(Effect.void);
    yield* Deferred.await(released);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(startup)));
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, NodeServices.layer))),
);

it.effect("shared signout closes an already-open voice resource", () =>
  Effect.gen(function* () {
    const binding = { owner: "provider" as const, key: "shared-open-voice" };
    const auth = yield* ProviderAuthFlow.make({
      instanceId: id,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const peerAuth = yield* ProviderAuthFlow.make({
      instanceId: peerId,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const access = yield* RuntimeAccess.RuntimeAccess;
    let released = false;
    yield* access.register(id, captured);
    yield* access
      .use(id, () =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            released = true;
          }),
        ),
      )
      .pipe(Effect.provide(registry([instance(id, auth), instance(peerId, peerAuth)])));
    assert.isFalse(released);
    yield* peerAuth.logout(Effect.void);
    assert.isTrue(released);
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, NodeServices.layer))),
);

it.effect("uses the captured managed account resolver instead of local credentials", () =>
  Effect.gen(function* () {
    const access = yield* RuntimeAccess.RuntimeAccess;
    const selected = {
      config: yield* decodeSettings({
        binaryPath: "/managed/codex",
        homePath: "/managed/selected-account",
      }),
      environment: { ACCESS_TOKEN: "test-only-managed-token" },
      revision: "selected-account",
    };
    yield* access.register(id, { ...captured, resolveRuntime: Effect.succeed(selected) });
    const runtime = yield* access.use(id, Effect.succeed);
    assert.strictEqual(runtime, selected);
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, registry([instance()])))),
);

it.effect("a missing runtime does not fall back to ambient credentials", () =>
  Effect.gen(function* () {
    const access = yield* RuntimeAccess.RuntimeAccess;
    let launched = false;
    const result = yield* access
      .use(id, () =>
        Effect.sync(() => {
          launched = true;
        }),
      )
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(launched);
  }).pipe(Effect.provide(Layer.mergeAll(RuntimeAccess.layer, registry([instance()])))),
);
