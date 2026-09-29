import { Cause, Effect, Exit } from "effect";
import type { z } from "zod";
import { failure } from "./errors";

/**
 * Runs an effect as a promise. Aborting the signal interrupts the effect and
 * rejects with the abort reason, which is what every Promise caller expects.
 */
export function run<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  if (signal?.aborted) {
    return Promise.reject(failure(signal.reason));
  }
  return Effect.runPromiseExit(effect, signal ? { signal } : undefined).then(
    (exit) => {
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      if (Cause.hasInterruptsOnly(exit.cause)) {
        throw failure(signal?.reason);
      }
      throw Cause.squash(exit.cause);
    },
  );
}

/** Runs a synchronous effect, throwing its typed failure as-is. */
export function runSync<A, E>(effect: Effect.Effect<A, E>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
}

/** Parses with a Zod schema. Callers map the issue to their own error. */
export function decode<T>(
  schema: z.ZodType<T>,
  value: unknown,
): Effect.Effect<T, z.ZodError> {
  const result = schema.safeParse(value);
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(result.error);
}

/** Combines optional caller signals with the owner's lifetime. */
export function within(
  lifetime: AbortSignal,
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const present = signals.filter((one): one is AbortSignal => !!one);
  return present.length ? AbortSignal.any([lifetime, ...present]) : lifetime;
}
