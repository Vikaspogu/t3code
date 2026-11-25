import * as Notifications from "expo-notifications";

import { environmentCatalog } from "../../connection/catalog";
import { subscribeAppActive } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  reconcileSelfHostedPushEnvironments,
  setAndroidThreadOnScreen,
  supportsSelfHostedPush,
} from "./androidNotifications";
import { selectSelfHostedAgentNotifications } from "./remoteRegistration";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

let deepLinkOnScreen: string | null = null;

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  deepLinkOnScreen = threadDeepLinkOnScreen(pathname);
  setAndroidThreadOnScreen(deepLinkOnScreen);
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the
 * thread already on screen, and taps (including the cold-start tap) open the
 * notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const stopReconciling = supportsSelfHostedPush() ? installSelfHostedPushReconciliation() : null;
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen)),
  });

  const handleResponse = (response: Notifications.NotificationResponse): void => {
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    stopReconciling?.();
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}

function installSelfHostedPushReconciliation(): () => void {
  const reconcile = () => {
    try {
      selectSelfHostedAgentNotifications();
    } catch {
      console.warn("[agent-awareness] could not save cloud notification pause");
    }
    try {
      reconcileSelfHostedPushEnvironments(appAtomRegistry.get(environmentCatalog.catalogValueAtom));
    } catch {
      console.warn("[agent-awareness] could not reconcile self-hosted notification bindings");
    }
  };
  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    reconcile,
    {
      immediate: true,
    },
  );
  const unsubscribeAppState = subscribeAppActive(reconcile);
  return () => {
    unsubscribeCatalog();
    unsubscribeAppState();
  };
}
