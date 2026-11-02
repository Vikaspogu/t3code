import { formatCallClock, formatWorkingTimer } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import { AppText as Text } from "../../components/ui/AppText";

/** Ticking elapsed-time label, mirroring the web chat WorkingTimer. */
export function WorkingTimer({
  createdAt,
  className,
}: {
  readonly createdAt: string;
  readonly className?: string;
}) {
  const nowMs = useVisibleSecondClock(true);
  const text =
    formatWorkingTimer(createdAt, DateTime.formatIso(DateTime.makeUnsafe(nowMs))) ?? "0s";
  return (
    <Text className={className} style={{ fontVariant: ["tabular-nums"] }}>
      {text}
    </Text>
  );
}

/** Ticking m:ss call-duration clock, mirroring the web CallTimer. */
export function CallTimer({
  createdAt,
  className,
}: {
  readonly createdAt: string;
  readonly className?: string;
}) {
  const nowMs = useVisibleSecondClock(true);
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / 1000));
  return (
    <Text className={className} style={{ fontVariant: ["tabular-nums"] }}>
      {formatCallClock(seconds)}
    </Text>
  );
}
