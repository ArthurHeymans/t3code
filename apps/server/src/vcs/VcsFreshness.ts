import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const nowFreshness = Effect.fn("VcsFreshness.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});
