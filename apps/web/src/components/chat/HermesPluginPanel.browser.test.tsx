import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { HermesPluginPanel } from "./HermesPluginPanel";
import type { useHermesPlugins } from "./useHermesPlugins";

it("discovers a tool and invokes an explicit RPC method", async () => {
  const invoke = vi.fn(async () => ({ echoed: "hello" }));
  const hermesPlugins = {
    enabled: true,
    canInvoke: true,
    toolsQuery: {
      data: {
        tools: [
          {
            name: "ivan_personal_echo",
            toolset: "ivan_personal",
            description: "Echo parameters",
          },
        ],
      },
      isPending: false,
      error: null,
      refresh: vi.fn(),
    },
    invoke,
  } as unknown as ReturnType<typeof useHermesPlugins>;
  await using _screen = await render(<HermesPluginPanel hermesPlugins={hermesPlugins} />);

  await page.getByText("Hermes plugins", { exact: true }).click();
  const select = page.getByRole("combobox", { name: "Hermes plugin tool" });
  await select.selectOptions("ivan_personal_echo");
  await page.getByRole("textbox", { name: "Plugin RPC method" }).fill("plugin.ivan_personal.echo");

  const parameters = page.getByRole("textbox", { name: "Plugin parameters as JSON" });
  await parameters.fill("[]");
  await page.getByRole("button", { name: "Invoke plugin" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Parameters must be a JSON object.");
  expect(invoke).not.toHaveBeenCalled();

  await parameters.fill('{"message":"hello"}');
  await page.getByRole("button", { name: "Invoke plugin" }).click();
  await expect
    .element(page.getByText(/"echoed":\s*"hello"/))
    .toHaveTextContent('{ "echoed": "hello" }');
  expect(invoke).toHaveBeenCalledWith("plugin.ivan_personal.echo", { message: "hello" });
});
