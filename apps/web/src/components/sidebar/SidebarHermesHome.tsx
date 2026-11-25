import type { HermesConversationHome } from "@t3tools/client-runtime/state/conversation-organization";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { useGT } from "gt-react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export const SidebarHermesHome = memo(function SidebarHermesHome(props: {
  home: HermesConversationHome;
  rowId: string;
  collapsed: boolean;
  loadedCount: number;
  attentionCount: number;
  unknownCount: number;
  availability: "ready" | "disabled" | "offline" | "checking" | "unavailable";
  onToggle: () => void;
  onNewConversation: () => void;
}) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(props.home.environmentId, AuthOrchestrationOperateScope);
  const status =
    props.availability === "disabled"
      ? gt("Provider disabled")
      : props.availability === "offline"
        ? gt("Disconnected")
        : props.availability === "checking"
          ? gt("Not checked")
          : props.availability === "unavailable"
            ? gt("Provider unavailable")
            : null;
  return (
    <li className="relative mt-2 list-none" data-testid="sidebar-hermes-home">
      <div className="flex items-center">
        <button
          type="button"
          data-sidebar-row={props.rowId}
          aria-expanded={!props.collapsed}
          aria-label={gt("{provider} conversations", { provider: props.home.displayName })}
          onClick={props.onToggle}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-sidebar-foreground">
              {props.home.displayName}
            </span>
            <span className="block text-xs text-sidebar-muted-foreground">
              {gt("Hermes")}
              {status ? ` · ${status}` : null}
            </span>
          </span>
          <span className="text-xs tabular-nums text-sidebar-muted-foreground">
            {props.loadedCount}
            <span className="sr-only"> {gt("Loaded active conversations and drafts")}</span>
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground",
              props.collapsed && "-rotate-90",
            )}
          />
        </button>
        <Button
          size="icon"
          variant="ghost-muted"
          data-sidebar-action-for={props.rowId}
          aria-label={gt("New conversation with {provider}", { provider: props.home.displayName })}
          disabled={props.availability !== "ready" || !canOperate}
          onClick={props.onNewConversation}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </div>
      {props.attentionCount > 0 || props.unknownCount > 0 ? (
        <div
          className="flex flex-wrap gap-x-3 px-(--sidebar-row-content-inset) pb-1 text-xs"
          aria-live="polite"
        >
          {props.attentionCount > 0 ? (
            <span className="text-warning-foreground">
              {gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
                count: props.attentionCount,
              })}
            </span>
          ) : null}
          {props.unknownCount > 0 ? (
            <span className="text-sidebar-muted-foreground">
              {gt("{count, plural, one {# not checked} other {# not checked}}", {
                count: props.unknownCount,
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
});
