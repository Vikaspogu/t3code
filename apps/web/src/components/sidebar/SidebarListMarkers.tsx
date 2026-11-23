import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { msg, useMessages } from "gt-react";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useLayoutEffect } from "react";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolvePinnedSidebarSummary,
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the projected drop box inside the scroll viewport as drag transforms move it
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [node, props.revealOverflow, transform?.y]);
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      // Revealing on every drag scrolls the list out from under the pointer.
      revealOverflow={
        props.marker === "settled-placeholder" && props.showHint && props.isDropTarget
      }
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker: "pinned-header" | "working-header" | "snoozed-header" | "settled-header";
  label: string;
  /** A muted trailing count. */
  count: number;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
  /** Threads summarized by the collapsed header, including any visible preview or route row. */
  hiddenThreads?: readonly EnvironmentThreadShell[] | undefined;
  pinnedStatusEnabled?: boolean;
}) {
  const m = useMessages();
  const localLastVisitedAtById = useUiStateStore((state) =>
    !props.toggle.expanded ? state.threadLastVisitedAtById : null,
  );
  const collapsedThreads = props.toggle.expanded ? undefined : props.hiddenThreads;
  const resolvedThreads = collapsedThreads?.map((thread) => ({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      localLastVisitedAtById?.[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    ),
  }));
  const dot =
    (props.marker !== "pinned-header" || props.pinnedStatusEnabled !== true) &&
    resolvedThreads !== undefined &&
    resolvedThreads.length > 0
      ? resolveSidebarFolderDot(resolvedThreads)
      : null;
  const summary =
    props.marker === "pinned-header" &&
    props.pinnedStatusEnabled === true &&
    resolvedThreads !== undefined
      ? resolvePinnedSidebarSummary(resolvedThreads)
      : null;
  const summaryItems =
    summary === null
      ? []
      : (
          [
            {
              count: summary.attention,
              label: msg("{count, plural, one {{count} needs you} other {{count} need you}}"),
              dot: "attention",
              color: "text-warning-foreground",
            },
            {
              count: summary.failed,
              label: msg("{count, plural, one {{count} failed} other {{count} failed}}"),
              dot: "failed",
              color: "text-error-foreground",
            },
            {
              count: summary.done,
              label: msg("{count, plural, one {{count} new} other {{count} new}}"),
              dot: "unread",
              color: "text-success-foreground",
            },
            {
              count: summary.working,
              label: msg("{count, plural, one {{count} working} other {{count} working}}"),
              dot: "working",
              color: "text-info-foreground",
            },
          ] as const
        ).filter((item) => item.count > 0);
  const shelf =
    props.marker === "pinned-header"
      ? "pinned"
      : props.marker === "working-header"
        ? "working"
        : props.marker === "snoozed-header"
          ? "snoozed"
          : "settled";
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn(
        "relative mx-0.5",
        summaryItems.length > 0 ? "min-h-8" : "h-8",
        props.className,
      )}
    >
      <CollapsibleSectionHeader
        data-sidebar-row={`shelf:${shelf}`}
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={
          <>
            {dot ? (
              <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
                <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
              </span>
            ) : null}
            <span className="font-normal tabular-nums">{props.count}</span>
          </>
        }
      >
        {props.label}
      </CollapsibleSectionHeader>
      {summaryItems.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-2 text-2xs leading-4">
          {summaryItems.map((item) => (
            <span key={item.dot} className={cn("inline-flex items-center gap-1.5", item.color)}>
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", FOLDER_DOT_CLASS_NAME[item.dot])}
              />
              <span className="tabular-nums">{m(item.label, { count: item.count })}</span>
            </span>
          ))}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}
