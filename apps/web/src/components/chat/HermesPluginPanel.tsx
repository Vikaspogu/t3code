import { msg } from "gt-react";
import { PuzzleIcon, RefreshCwIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "../../i18n/messages";
import { Button } from "../ui/button";
import { useHermesPlugins } from "./useHermesPlugins";

function parsePluginParams(value: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
export function HermesPluginPanel({
  hermesPlugins,
}: {
  readonly hermesPlugins: ReturnType<typeof useHermesPlugins>;
}) {
  const [selectedName, setSelectedName] = useState("");
  const [rpcMethod, setRpcMethod] = useState("plugin.");
  const [paramsText, setParamsText] = useState("{}");
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  if (!hermesPlugins.enabled) return null;

  const toolData = hermesPlugins.toolsQuery.data;
  const tools =
    toolData && typeof toolData === "object" && "tools" in toolData ? toolData.tools : [];
  const selected = tools.find((tool) => tool.name === selectedName);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!hermesPlugins.canInvoke) return;
    setError(null);
    setResult(undefined);
    const params = parsePluginParams(paramsText);
    if (!params) {
      setError(m(msg("Parameters must be a JSON object.")));
      return;
    }
    setInvoking(true);
    const outcome = await hermesPlugins.invoke(rpcMethod.trim(), params).then(
      (value) => ({ result: value }) as const,
      (cause: unknown) =>
        ({
          error: cause instanceof Error ? cause.message : m(msg("The plugin request failed.")),
        }) as const,
    );
    setInvoking(false);
    if ("error" in outcome) {
      setError(outcome.error);
    } else {
      setResult(outcome.result);
    }
  };

  return (
    <details className="border-t border-border/60 bg-background/40 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-muted-foreground hover:text-foreground sm:px-5">
        <PuzzleIcon className="size-3.5" aria-hidden />
        <span>{m(msg("Hermes plugins"))}</span>
        <span className="text-muted-foreground/70">{tools.length}</span>
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
        <div className="flex items-center gap-2">
          <select
            aria-label={m(msg("Hermes plugin tool"))}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5"
            value={selectedName}
            onChange={(event) => {
              setSelectedName(event.target.value);
              setResult(undefined);
              setError(null);
            }}
          >
            <option value="">{m(msg("Select a plugin tool"))}</option>
            {tools.map((tool) => (
              <option key={tool.name} value={tool.name}>
                {tool.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={m(msg("Refresh Hermes plugin tools"))}
            onClick={hermesPlugins.toolsQuery.refresh}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
        </div>
        {hermesPlugins.toolsQuery.isPending ? (
          <p className="m-0 text-muted-foreground">{m(msg("Loading plugin tools…"))}</p>
        ) : null}
        {hermesPlugins.toolsQuery.error ? (
          <p role="alert" className="m-0 text-destructive">
            {hermesPlugins.toolsQuery.error}
          </p>
        ) : null}
        {selected ? (
          <p className="m-0 whitespace-pre-wrap text-muted-foreground">{selected.description}</p>
        ) : null}
        {hermesPlugins.canInvoke ? (
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <input
              aria-label={m(msg("Plugin RPC method"))}
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono"
              value={rpcMethod}
              onChange={(event) => setRpcMethod(event.target.value)}
              placeholder="plugin.example.method"
              spellCheck={false}
            />
            <textarea
              aria-label={m(msg("Plugin parameters as JSON"))}
              className="min-h-20 resize-y rounded-md border border-input bg-background p-2 font-mono"
              value={paramsText}
              onChange={(event) => setParamsText(event.target.value)}
              spellCheck={false}
            />
            <Button type="submit" size="sm" variant="outline" disabled={invoking}>
              {invoking ? m(msg("Invoking…")) : m(msg("Invoke plugin"))}
            </Button>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="m-0 whitespace-pre-wrap text-destructive">
            {error}
          </p>
        ) : null}
        {result !== undefined ? (
          <pre className="m-0 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
