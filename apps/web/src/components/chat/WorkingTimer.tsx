import { useEffect, useRef } from "react";
import { formatWorkingTimerNow } from "@t3tools/shared/orchestrationTiming";

export function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the elapsed-time DOM label current without rerendering the conversation.
  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}
