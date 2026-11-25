import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { attachedHermesHomes, groupConversationsByHome } from "./conversationOrganization.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const instanceId = ProviderInstanceId.make("cluster-assistant");
const otherInstanceId = ProviderInstanceId.make("hermes-coding");
const hermes = ProviderDriverKind.make("hermes");
const coding = ProviderDriverKind.make("pi");
const settings = (enabled = true): Pick<ServerSettings, "providerInstances"> => ({
  providerInstances: {
    [instanceId]: { driver: hermes, displayName: "Cluster assistant", enabled },
    [otherInstanceId]: { driver: coding, enabled: true },
  },
});
const thread = (id: string, providerInstanceId = instanceId, environmentId = environmentA) => ({
  id,
  environmentId,
  providerInstanceId,
  projectId: null,
  pinned: false,
});

describe("conversation organization", () => {
  it("attaches Hermes by configured driver, not instance name or enabled state", () => {
    const homes = attachedHermesHomes([[environmentA, settings(false)]]);
    expect(homes).toHaveLength(1);
    expect(homes[0]).toEqual({
      environmentId: environmentA,
      instanceId,
      displayName: "Cluster assistant",
      enabled: false,
    });
    expect(attachedHermesHomes([])).toEqual([]);
    expect(attachedHermesHomes([[environmentA, { providerInstances: {} }]])).toEqual([]);
  });

  it("keeps the same provider instance ID separate in two environments", () => {
    const homes = attachedHermesHomes([
      [environmentA, settings()],
      [environmentB, settings()],
    ]);
    const a = thread("a");
    const b = thread("b", instanceId, environmentB);
    const result = groupConversationsByHome([a, b], homes);
    expect(result.hermes.map((group) => group.conversations)).toEqual([[a], [b]]);
    expect(result.coding).toEqual([]);
  });

  it("keeps projectless coding conversations out of Hermes", () => {
    const a = thread("coding-without-project", otherInstanceId);
    const b = { ...thread("Hermes-with-stored-project"), projectId: "scratch-project" };
    const result = groupConversationsByHome(
      [a, b],
      attachedHermesHomes([[environmentA, settings()]]),
    );
    expect(result.coding).toEqual([a]);
    expect(result.hermes[0]?.conversations).toEqual([b]);
    expect(result.hermes[0]?.conversations[0]).toBe(b);
  });

  it("retains removed-provider history in coding without mutating its project or pins", () => {
    const a = { ...thread("retained"), projectId: "original-project", pinned: true };
    const result = groupConversationsByHome([a], []);
    expect(result.hermes).toEqual([]);
    expect(result.coding[0]).toBe(a);
    expect(a.projectId).toBe("original-project");
    expect(a.pinned).toBe(true);
  });

  it("changes membership with current selection while preserving order and identity", () => {
    const a = thread("a", otherInstanceId);
    const b = thread("b");
    const c = thread("c");
    const homes = attachedHermesHomes([[environmentA, settings()]]);
    expect(groupConversationsByHome([a, b, c], homes).hermes[0]?.conversations).toEqual([b, c]);
    const switched = { ...b, providerInstanceId: otherInstanceId };
    const result = groupConversationsByHome([a, switched, c], homes);
    expect(result.coding).toEqual([a, switched]);
    expect(result.hermes[0]?.conversations).toEqual([c]);
    expect(result.coding[0]).toBe(a);
  });

  it("retains every attached home even when it has no conversations", () => {
    const homes = attachedHermesHomes([[environmentA, settings(false)]]);
    expect(groupConversationsByHome([], homes).hermes).toEqual([
      { home: homes[0], conversations: [] },
    ]);
  });
});
