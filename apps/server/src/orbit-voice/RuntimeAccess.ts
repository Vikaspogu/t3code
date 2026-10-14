import {
  type CodexSettings,
  type ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import type { CodexEffectiveRuntime } from "../provider/CodexManagedRuntime.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { withProviderInstanceAccess } from "../orchestration-v2/ProviderAdapterRegistry.ts";

export interface CapturedRuntime {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
}

export class RuntimeAccess extends Context.Service<
  RuntimeAccess,
  {
    readonly register: (
      instanceId: ProviderInstanceId,
      runtime: CapturedRuntime,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly use: <A, E, R>(
      instanceId: ProviderInstanceId,
      run: (
        runtime: Pick<CodexEffectiveRuntime, "config" | "environment">,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | ProviderSetupError,
      R | Scope.Scope | ProviderInstanceRegistry.ProviderInstanceRegistry
    >;
  }
>()("t3/orbit-voice/RuntimeAccess") {}

const make = () => {
  const entries = new Map<
    ProviderInstanceId,
    { runtime: CapturedRuntime; calls: Set<Scope.Closeable> }
  >();
  return RuntimeAccess.of({
    register: (instanceId, runtime) =>
      Effect.gen(function* () {
        const entry = { runtime, calls: new Set<Scope.Closeable>() };
        entries.set(instanceId, entry);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (entries.get(instanceId) === entry) entries.delete(instanceId);
            yield* Effect.forEach([...entry.calls], (scope) => Scope.close(scope, Exit.void), {
              discard: true,
            });
          }),
        );
      }),
    use: (instanceId, run) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
          const instance = yield* instances.getInstance(instanceId);
          const entry = entries.get(instanceId);
          if (!entry || !instance?.enabled || instance.driverKind !== "codex") {
            return yield* new ProviderSetupError({
              instanceId,
              operation: "voice",
              detail: "The selected Codex runtime is unavailable.",
            });
          }
          const parent = yield* Scope.Scope;
          const child = yield* Scope.make();
          entry.calls.add(child);
          yield* Scope.addFinalizer(
            child,
            Effect.sync(() => {
              entry.calls.delete(child);
            }),
          );
          yield* Scope.addFinalizer(parent, Scope.close(child, Exit.void));
          const task = withProviderInstanceAccess(
            instances,
            instance,
            Effect.gen(function* () {
              const runtime = entry.runtime.resolveRuntime
                ? yield* entry.runtime.resolveRuntime
                : { config: entry.runtime.settings, environment: entry.runtime.environment };
              return yield* run(runtime);
            }),
          );
          const fiber = yield* restore(task).pipe(
            Effect.provideService(Scope.Scope, child),
            Effect.forkIn(child),
          );
          return yield* restore(Fiber.await(fiber)).pipe(
            Effect.flatMap((result) => result),
            Effect.onExit((result) =>
              Exit.isFailure(result) ? Scope.close(child, Exit.void) : Effect.void,
            ),
          );
        }),
      ),
  });
};

export const layer = Layer.sync(RuntimeAccess, make);
