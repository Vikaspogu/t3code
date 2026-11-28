import hermesSymbolUrl from "../../assets/hermes-symbol.png";
import { cn } from "~/lib/utils";

export function SidebarHermesIcon({ className }: { className?: string }) {
  return (
    <img
      src={hermesSymbolUrl}
      alt=""
      aria-hidden
      data-testid="sidebar-hermes-icon"
      className={cn("size-4 shrink-0 rounded-sm object-cover", className)}
    />
  );
}
