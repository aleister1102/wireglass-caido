import { flushPromises, mount } from "@vue/test-utils";
import { loadJq, type Jq } from "jq-wasm/inline";
import type { StreamWsMessageMeta } from "@caido/sdk-frontend/src/types/types/websocket";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import { executeJq } from "../../lib/jq/execute";
import type { JqRequest } from "../../lib/jq/contract";
import { isInspectable } from "../../lib/messageContent";
import { useSession } from "../../lib/session";

let jq: Jq;
let hang = false;
vi.mock("../../lib/jq/createWorker", () => ({
  createJqWorker: async () => {
    const worker = {
      terminated: false,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onerror: null,
      postMessage(message: JqRequest) {
        if (hang) return;
        setTimeout(() => {
          if (!worker.terminated) worker.onmessage?.({ data: { id: message.id, outcome: executeJq(jq, message.input, message.query) } });
        }, 1);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    return worker;
  },
}));

const { lz4WasmBytes, sdkBlob, sizedBlock } = await import("../../lib/__tests__/lz4Fixture");

const { default: MessageInspector } = await import("../MessageInspector.vue");

const SOCKET = '42/logger_server,["event",{"level":"info","msg":"<b>hi</b>"}]';
const writeText = vi.fn(async (_text: string) => undefined);

beforeAll(async () => {
  jq = await loadJq();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

beforeEach(() => {
  hang = false;
  writeText.mockClear();
  const session = useSession();
  session.changeProject(undefined);
  session.preset.value = null;
});

function message(id: string, streamId = "1", direction: "CLIENT" | "SERVER" = "SERVER", format: StreamWsMessageMeta["head"]["format"] = "TEXT") {
  return {
    type: "StreamWsMessageMeta",
    id,
    streamId,
    head: { id, length: 10, direction, format, createdAt: new Date("2026-10-30T07:07:10Z") },
  } as unknown as StreamWsMessageMeta;
}

const editorView = (content: string) => ({ state: { doc: { toString: () => content } } }) as never;
const frames = new Map<string, Uint8Array>();
const held = new Map<string, Promise<void>>();
const sdk = {
  assets: { get: async () => ({ asArrayBuffer: async () => lz4WasmBytes().buffer }) },
  graphql: {
    websocketMessageEdit: async ({ id }: { id: string }) => {
      await held.get(id);
      return { streamWsMessageEdit: { raw: sdkBlob(frames.get(id) ?? new Uint8Array()) } };
    },
  },
} as never;

function mountInspector(content: string, msg = message("1")) {
  return mount(MessageInspector, { props: { sdk, message: msg, view: editorView(content) } });
}

function editorIn(wrapper: ReturnType<typeof mountInspector>, testId: string): EditorView {
  const view = EditorView.findFromDOM(wrapper.get(`[data-testid="${testId}"] .cm-editor`).element as HTMLElement);
  if (!view) throw new Error(`no editor in ${testId}`);
  return view;
}

const shown = (wrapper: ReturnType<typeof mountInspector>) => editorIn(wrapper, "wireglass-content").state.doc.toString();
const wraps = (wrapper: ReturnType<typeof mountInspector>) => editorIn(wrapper, "wireglass-content").lineWrapping;

describe("MessageInspector", () => {
  it("defaults to Pretty JSON for a JSON payload and Wrapped original for other text", () => {
    const json = mountInspector(SOCKET);
    expect(json.get('[data-testid="wireglass-preset-pretty"]').classes()).toContain("active");
    expect(shown(json)).toBe('[\n  "event",\n  {\n    "level": "info",\n    "msg": "<b>hi</b>"\n  }\n]');

    const raw = mountInspector("plain text");
    expect(raw.get('[data-testid="wireglass-preset-wrapped"]').classes()).toContain("active");
    expect(shown(raw)).toBe("plain text");
  });

  it("shows the original exactly, with HTML-like strings as text", async () => {
    const wrapper = mountInspector(SOCKET);
    await wrapper.get('[data-testid="wireglass-preset-wrapped"]').trigger("click");
    expect(shown(wrapper)).toBe(SOCKET);
    expect(wrapper.get('[data-testid="wireglass-content"]').find("b").exists()).toBe(false);
    expect(wraps(wrapper)).toBe(true);
    expect(wrapper.get('[data-testid="wireglass-fact-event"]').text()).toContain("event");
    expect(wrapper.get('[data-testid="wireglass-fact-namespace"]').text()).toContain("/logger_server");
  });

  it("switches presets and disables JSON presets for raw content", async () => {
    const wrapper = mountInspector('{"b":1, "a":[1,2]}');
    await wrapper.get('[data-testid="wireglass-preset-pretty"]').trigger("click");
    expect(shown(wrapper)).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}');
    await wrapper.get('[data-testid="wireglass-preset-compact"]').trigger("click");
    expect(shown(wrapper)).toBe('{"b":1,"a":[1,2]}');
    await wrapper.get('[data-testid="wireglass-preset-original"]').trigger("click");
    expect(wraps(wrapper)).toBe(false);

    const raw = mountInspector("plain text");
    expect(raw.get('[data-testid="wireglass-preset-pretty"]').attributes("disabled")).toBeDefined();
    expect(raw.get('[data-testid="wireglass-copy-payload"]').attributes("disabled")).toBeDefined();
  });

  it("explains an unavailable preset when the selected message has no payload", async () => {
    useSession().preset.value = "pretty";
    const wrapper = mountInspector("plain text");
    expect(wrapper.get('[data-testid="wireglass-unavailable"]').text()).toContain("no decoded JSON payload");
  });

  it("copies the original and the payload separately", async () => {
    const wrapper = mountInspector(SOCKET);
    await wrapper.get('[data-testid="wireglass-copy-original"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(SOCKET);
    await wrapper.get('[data-testid="wireglass-preset-compact"]').trigger("click");
    await wrapper.get('[data-testid="wireglass-copy-payload"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith('["event",{"level":"info","msg":"<b>hi</b>"}]');
    expect(wrapper.get('[data-testid="wireglass-copied"]').text()).toBe("Payload copied");
  });

  it("shows explicit JSON errors without replacing the original", async () => {
    const wrapper = mountInspector('{"broken": tru');
    await wrapper.get('[data-testid="wireglass-decoder"]').setValue("json");
    expect(wrapper.get('[data-testid="wireglass-fact-error"]').text()).toBe("Error Unexpected character at character 12");
    expect(shown(wrapper)).toBe('{"broken": tru');
  });

  it("keeps a decoder override across messages on the same connection only", async () => {
    const wrapper = mountInspector('{"a":1}', message("1", "7"));
    await wrapper.get('[data-testid="wireglass-decoder"]').setValue("raw");
    await wrapper.setProps({ message: message("2", "7"), view: editorView('{"b":2}') });
    expect((wrapper.get('[data-testid="wireglass-decoder"]').element as HTMLSelectElement).value).toBe("raw");
    await wrapper.setProps({ message: message("3", "8"), view: editorView('{"c":3}') });
    expect((wrapper.get('[data-testid="wireglass-decoder"]').element as HTMLSelectElement).value).toBe("auto");
    useSession().changeProject("p2");
    await wrapper.setProps({ message: message("4", "7"), view: editorView('{"d":4}') });
    expect((wrapper.get('[data-testid="wireglass-decoder"]').element as HTMLSelectElement).value).toBe("auto");
  });

  it("runs jq only on request with the complete Socket.IO payload, and copies the exact result", async () => {
    const wrapper = mountInspector(SOCKET);
    await wrapper.get('[data-testid="wireglass-jq-query"]').setValue(".[0], .[1].msg");
    await flushPromises();
    expect(wrapper.find('[data-testid="wireglass-jq-stdout"]').exists()).toBe(false);
    await wrapper.get('[data-testid="wireglass-jq-query"]').trigger("keydown", { key: "Enter", metaKey: true });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-jq-stdout"]').exists()).toBe(true));
    const stdout = editorIn(wrapper, "wireglass-jq-stdout");
    expect(stdout.state.doc.toString()).toBe('"event"\n"<b>hi</b>"');
    expect(stdout.state.facet(language)?.name).toBe("json");
    await wrapper.get('[data-testid="wireglass-jq-copy"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith('"event"\n"<b>hi</b>"');
  });

  it("keeps non-JSON output and stderr readable", async () => {
    const wrapper = mountInspector('{"a":1}');
    await wrapper.get('[data-testid="wireglass-jq-query"]').setValue(".a | foo");
    await wrapper.get('[data-testid="wireglass-jq-run"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-jq-stderr"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="wireglass-jq-stderr"]').text()).toContain("foo/0 is not defined");
    expect(wrapper.get('[data-testid="wireglass-jq-status"]').text()).toContain("Exit 3");
  });

  it("cancels a running query and clears results when the selection changes", async () => {
    hang = true;
    const wrapper = mountInspector('{"a":1}');
    await wrapper.get('[data-testid="wireglass-jq-run"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="wireglass-jq-status"]').text()).toBe("Running…");
    await wrapper.get('[data-testid="wireglass-jq-cancel"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="wireglass-jq-status"]').text()).toBe("Cancelled");

    await wrapper.get('[data-testid="wireglass-jq-run"]').trigger("click");
    await flushPromises();
    await wrapper.setProps({ message: message("2"), view: editorView('{"b":2}') });
    await flushPromises();
    expect(wrapper.get('[data-testid="wireglass-jq-status"]').text()).toBe("");
    expect(wrapper.find('[data-testid="wireglass-jq-run"]').exists()).toBe(true);
  });

  it("keeps the newer run active when a run is restarted with Ctrl/Cmd+Enter", async () => {
    hang = true;
    const wrapper = mountInspector('{"a":1}');
    const input = wrapper.get('[data-testid="wireglass-jq-query"]');
    await input.trigger("keydown", { key: "Enter", metaKey: true });
    await input.trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();
    expect(wrapper.get('[data-testid="wireglass-jq-status"]').text()).toBe("Running…");
    expect(wrapper.find('[data-testid="wireglass-jq-cancel"]').exists()).toBe(true);
  });

  it("clears a running query when the decoder changes on the same message", async () => {
    hang = true;
    const wrapper = mountInspector(SOCKET);
    await wrapper.get('[data-testid="wireglass-jq-run"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="wireglass-decoder"]').setValue("raw");
    await flushPromises();
    expect(wrapper.get('[data-testid="wireglass-jq-status"]').text()).toBe("");
  });

  it("unmounts cleanly", () => {
    const wrapper = mountInspector("x");
    wrapper.unmount();
    expect(wrapper.exists()).toBe(false);
  });

  it("decodes an LZ4 binary frame from its exact bytes when the LZ4 decoder is chosen", async () => {
    const json = '{"status":"OK","payload":{"name":"Vàng"}}';
    frames.set("31", sizedBlock(json));
    const shownText = "\u0000\u0000\u0000)�{\"status\"";
    const wrapper = mountInspector(shownText, message("31", "9", "SERVER", "BINARY"));
    expect(wrapper.get('[data-testid="wireglass-fact-decoder"]').text()).toContain("Auto: binary frame, not parsed");

    await wrapper.get('[data-testid="wireglass-decoder"]').setValue("lz4");
    expect(wrapper.get('[data-testid="wireglass-fact-decoder"]').text()).toContain("reading frame bytes");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-fact-decompressed"]').exists()).toBe(true));

    expect(wrapper.get('[data-testid="wireglass-preset-pretty"]').classes()).toContain("active");
    expect(shown(wrapper)).toBe('{\n  "status": "OK",\n  "payload": {\n    "name": "Vàng"\n  }\n}');
    expect(wrapper.get('[data-testid="wireglass-fact-decompressed"]').text()).toContain(`${new TextEncoder().encode(json).length} bytes`);

    await wrapper.get('[data-testid="wireglass-jq-query"]').setValue(".payload.name");
    await wrapper.get('[data-testid="wireglass-jq-run"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-jq-stdout"]').exists()).toBe(true));
    expect(editorIn(wrapper, "wireglass-jq-stdout").state.doc.toString()).toBe('"Vàng"');

    await wrapper.get('[data-testid="wireglass-preset-wrapped"]').trigger("click");
    expect(shown(wrapper)).toBe(shownText);
  });

  it("shows the LZ4 result of the selected message when an earlier selection finishes later", async () => {
    frames.set("41", sizedBlock('{"n":1}'));
    frames.set("42", sizedBlock('{"n":2}'));
    let release!: () => void;
    held.set("41", new Promise<void>((resolve) => (release = resolve)));
    useSession().setDecoder({ streamId: "8", direction: "SERVER" }, { kind: "builtin", mode: "lz4" });
    const wrapper = mountInspector("a", message("41", "8", "SERVER", "BINARY"));
    await wrapper.setProps({ message: message("42", "8", "SERVER", "BINARY"), view: editorView("b") });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-fact-decompressed"]').exists()).toBe(true));
    release();
    held.delete("41");
    await flushPromises();
    expect(shown(wrapper)).toBe('{\n  "n": 2\n}');
  });

  it("reads the frame again after leaving the LZ4 decoder and returning", async () => {
    frames.set("61", sizedBlock('{"v":1}'));
    useSession().setDecoder({ streamId: "6", direction: "SERVER" }, { kind: "builtin", mode: "lz4" });
    const wrapper = mountInspector("x", message("61", "6", "SERVER", "BINARY"));
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-fact-decompressed"]').exists()).toBe(true));
    frames.set("61", sizedBlock('{"v":2}'));
    await wrapper.get('[data-testid="wireglass-decoder"]').setValue("raw");
    await wrapper.get('[data-testid="wireglass-decoder"]').setValue("lz4");
    await vi.waitFor(() => expect(shown(wrapper)).toBe('{\n  "v": 2\n}'));
  });

  it("says the frame is still being read when Pretty JSON is chosen", async () => {
    frames.set("71", sizedBlock('{"v":1}'));
    let release!: () => void;
    held.set("71", new Promise<void>((resolve) => (release = resolve)));
    useSession().preset.value = "pretty";
    useSession().setDecoder({ streamId: "5", direction: "SERVER" }, { kind: "builtin", mode: "lz4" });
    const wrapper = mountInspector("x", message("71", "5", "SERVER", "BINARY"));
    expect(wrapper.text()).toContain("Reading the frame bytes…");
    release();
    held.delete("71");
    await vi.waitFor(() => expect(shown(wrapper)).toBe('{\n  "v": 1\n}'));
  });

  it("reports a malformed LZ4 frame in the footer", async () => {
    const frame = sizedBlock('{"status":"OK"}');
    frames.set("51", frame.slice(0, frame.length - 4));
    useSession().setDecoder({ streamId: "7", direction: "SERVER" }, { kind: "builtin", mode: "lz4" });
    const wrapper = mountInspector("x", message("51", "7", "SERVER", "BINARY"));
    await vi.waitFor(() => expect(wrapper.find('[data-testid="wireglass-fact-error"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="wireglass-fact-error"]').text()).toContain("LZ4 block could not be decompressed");
    expect(wrapper.get('[data-testid="wireglass-preset-pretty"]').attributes("disabled")).toBeDefined();
  });
});

describe("isInspectable", () => {
  it("accepts text and binary frames", () => {
    expect(isInspectable(message("1"))).toBe(true);
    expect(isInspectable(message("1", "1", "SERVER", "BINARY"))).toBe(true);
    for (const format of ["CLOSE", "PING", "PONG"] as const) {
      expect(isInspectable(message("1", "1", "SERVER", format))).toBe(false);
    }
  });
});
