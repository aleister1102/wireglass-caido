import type { Caido, SettingsSlot } from "@caido/sdk-frontend";
import LayoutSettings from "./components/LayoutSettings.vue";
import MessageInspector from "./views/MessageInspector.vue";
import { createLayoutCatalog } from "./lib/layout/catalog";
import { useLayoutRegistry } from "./lib/layout/registry";
import { isInspectable } from "./lib/messageContent";
import { useSession } from "./lib/session";

/** The declared value of `SettingsSlot.PluginsSection`; the SDK package ships types only at runtime. */
const PLUGINS_SECTION: SettingsSlot = "plugins-section";

export const init = (sdk: Caido) => {
  const session = useSession();
  sdk.projects.onCurrentProjectChange((event) => session.changeProject(event.projectId));

  const viewMode = { label: "Wireglass", view: { component: MessageInspector }, when: isInspectable };
  sdk.websocket.addMessageViewMode(viewMode);
  sdk.replay.addWebsocketMessageViewMode(viewMode);

  const catalog = createLayoutCatalog({
    storage: sdk.kv,
    registry: useLayoutRegistry(),
  });
  void catalog.load();
  sdk.settings.addToSlot(PLUGINS_SECTION, {
    type: "Custom",
    name: "Layouts",
    definition: { component: LayoutSettings, props: { catalog } },
  });
};
