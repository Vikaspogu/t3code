import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarProvider, SidebarTrigger, useSidebar } from "../ui/sidebar";

vi.mock("../../state/environments", async (original) => {
  const actual = await original<typeof import("../../state/environments")>();
  return {
    ...actual,
    usePullRequestsSupported: () => true,
    useIssuesSupported: () => true,
  };
});
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => null }));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", async (original) => {
  const actual = await original<typeof import("./SidebarUpdatePill")>();
  return { ...actual, SidebarUpdateArchitectureWarning: () => null };
});
vi.mock("../../state/desktopUpdate", async (original) => ({
  ...(await original<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: () => ({
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  }),
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: false,
    summary: "Update everything",
    version: null,
    providerCount: 0,
    rows: [],
    restarts: [],
  }),
}));

function MobileStateProbe() {
  const { openMobile } = useSidebar();
  return <output data-testid="mobile-state">{String(openMobile)}</output>;
}

function enableOrganization() {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarPinnedStatusEnabled: true });
}

it("places Scheduled tasks before Usage, navigates without search, and fits the sidebar", async () => {
  enableOrganization();
  await page.viewport(1280, 800);
  await using screen = await render(
    <div style={{ width: "16rem" }}>
      <SidebarProvider>
        <SidebarChromeFooter />
      </SidebarProvider>
    </div>,
  );
  const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  const scheduled = screen.getByRole("button", { name: "Scheduled tasks", exact: true });
  const usage = screen.getByRole("button", { name: "Usage", exact: true });
  await expect.element(scheduled).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Update 0.0.50-nightly.2 ready to download" }))
    .toBeVisible();
  expect(scheduled.element().closest('[data-sidebar="menu-item"]')?.nextElementSibling).toBe(
    usage.element().closest('[data-sidebar="menu-item"]'),
  );

  const footer = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
  expect(footer).not.toBeNull();
  expect(footer!.scrollWidth).toBeLessThanOrEqual(256);
  expect(usage.element().getBoundingClientRect().right).toBeLessThanOrEqual(256);

  await userEvent.click(scheduled);
  expect(navigate).toHaveBeenCalledWith({ to: "/settings/scheduled-tasks" });
});

it("omits Scheduled tasks when conversation organization is disabled", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarPinnedStatusEnabled: false });
  await using screen = await render(
    <SidebarProvider>
      <SidebarChromeFooter />
    </SidebarProvider>,
  );
  expect(screen.getByRole("button", { name: "Scheduled tasks", exact: true }).query()).toBeNull();
  await expect.element(screen.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
});

it("closes the mobile-web drawer before opening Scheduled tasks", async () => {
  enableOrganization();
  await page.viewport(390, 844);
  await using screen = await render(
    <SidebarProvider>
      <SidebarTrigger />
      <MobileStateProbe />
      <SidebarChromeFooter />
    </SidebarProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  await expect.element(screen.getByTestId("mobile-state")).toHaveTextContent("true");
  await userEvent.click(screen.getByRole("button", { name: "Scheduled tasks", exact: true }));
  await expect.element(screen.getByTestId("mobile-state")).toHaveTextContent("false");
});

it("keeps utility-page Back mode free of Scheduled tasks and Usage", async () => {
  enableOrganization();
  await using screen = await render(
    <SidebarProvider>
      <SidebarChromeFooter />
    </SidebarProvider>,
    { router: "/pull-requests" },
  );
  const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  expect(screen.getByRole("button", { name: "Scheduled tasks", exact: true }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Usage", exact: true }).query()).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
  expect(navigate).toHaveBeenCalledWith({ href: "/" });
});
