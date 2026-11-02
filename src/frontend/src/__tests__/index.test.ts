import { init } from "../index";
import { isInspectable } from "../lib/messageContent";
import { useSession } from "../lib/session";

describe("init", () => {
  it("registers both view modes and clears overrides when the Caido project changes", () => {
    let onProjectChange: ((event: { projectId: string | undefined }) => void) | undefined;
    const sdk = {
      projects: { onCurrentProjectChange: (callback: typeof onProjectChange) => (onProjectChange = callback) },
      websocket: { addMessageViewMode: vi.fn() },
      replay: { addWebsocketMessageViewMode: vi.fn() },
      kv: { define: vi.fn(async () => undefined), get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
      settings: { addToSlot: vi.fn(() => ({ remove: vi.fn() })) },
    };
    init(sdk as never);

    for (const register of [sdk.websocket.addMessageViewMode, sdk.replay.addWebsocketMessageViewMode]) {
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ label: "Wireglass", when: isInspectable }));
    }

    const session = useSession();
    const scope = { streamId: "7", direction: "CLIENT" } as const;
    session.setDecoder(scope, { kind: "builtin", mode: "raw" });
    onProjectChange?.({ projectId: "p2" });
    expect(session.decoderFor(scope)).toEqual({ kind: "builtin", mode: "auto" });
  });

  it("loads the layout catalog and adds the Layouts settings section", () => {
    const sdk = {
      projects: { onCurrentProjectChange: vi.fn() },
      websocket: { addMessageViewMode: vi.fn() },
      replay: { addWebsocketMessageViewMode: vi.fn() },
      kv: { define: vi.fn(async () => undefined), get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
      settings: { addToSlot: vi.fn(() => ({ remove: vi.fn() })) },
    };
    init(sdk as never);

    expect(sdk.kv.define).toHaveBeenCalledWith("layout-catalog", { exportable: false });
    expect(sdk.settings.addToSlot).toHaveBeenCalledWith(
      "plugins-section",
      expect.objectContaining({ type: "Custom", name: "Layouts", definition: expect.objectContaining({ props: expect.anything() }) }),
    );
  });
});
