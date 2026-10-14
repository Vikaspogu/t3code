import { formatCallClock, formatWorkingTimerNow } from "@t3tools/shared/orchestrationTiming";
import { useEffect, useState } from "react";
import { AppText as Text } from "../../components/AppText";

/** Ticking elapsed-time label, mirroring the web chat WorkingTimer. */
export function WorkingTimer({
  createdAt,
  className,
}: {
  readonly createdAt: string;
  readonly className?: string;
}) {
  const [text, setText] = useState(() => formatWorkingTimerNow(createdAt));
  useEffect(() => {
    setText(formatWorkingTimerNow(createdAt));
    const id = setInterval(() => setText(formatWorkingTimerNow(createdAt)), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
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
  const elapsedSeconds = () => Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000));
  const [seconds, setSeconds] = useState(elapsedSeconds);
  useEffect(() => {
    setSeconds(elapsedSeconds());
    const id = setInterval(() => setSeconds(elapsedSeconds()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return (
    <Text className={className} style={{ fontVariant: ["tabular-nums"] }}>
      {formatCallClock(seconds)}
    </Text>
  );
}
