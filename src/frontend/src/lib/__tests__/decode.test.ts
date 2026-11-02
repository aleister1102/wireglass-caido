import { decode, payloadOf } from "../decode";
import { defaultPreset, describeDecoded, payloadCopyText, presetAvailable, renderPreset } from "../view";
import { createSession } from "../session";

const SOCKET = '42/logger_server,["event",{"level":"info","msg":"<b>hi</b>"}]';

describe("decode", () => {
  it("Auto prefers complete JSON, including numeric text such as 42", () => {
    expect(decode("42", "auto").kind).toBe("json");
    expect(decode('{"a":1}', "auto").kind).toBe("json");
  });

  it("Auto falls back to a complete Socket.IO event", () => {
    const decoded = decode(SOCKET, "auto");
    expect(decoded.kind).toBe("socketio");
    expect(payloadOf(decoded)?.text).toBe('["event",{"level":"info","msg":"<b>hi</b>"}]');
  });

  it("Auto leaves other text raw, including Socket.IO controls", () => {
    for (const text of ["plain text", '{"broken": tru', "2probe", "42/admin["]) {
      expect(decode(text, "auto").kind).toBe("raw");
    }
  });

  it("Raw never parses", () => {
    expect(decode('{"a":1}', "raw")).toEqual({ kind: "raw", mode: "raw", reason: "chosen" });
  });

  it("explicit JSON reports errors", () => {
    expect(decode('{"broken": tru', "json")).toMatchObject({ kind: "error", decoder: "json" });
  });

  it("explicit Socket.IO decodes controls and reports errors", () => {
    expect(decode("2probe", "socketio")).toMatchObject({ kind: "socketio", packet: { type: "ping", data: "probe" } });
    expect(decode("42", "socketio")).toMatchObject({ kind: "error", decoder: "socketio" });
  });

  it("reports error positions in characters, not UTF-16 units", () => {
    const text = '42["é😀",1';
    expect(describeDecoded(text, decode(text, "socketio")).find((f) => f.key === "error")?.value).toBe("Invalid JSON payload: Expected a closing bracket at character 10");
  });
});

describe("presets", () => {
  it("marks the payload offset inside the original without changing text", () => {
    const view = renderPreset(SOCKET, decode(SOCKET, "auto"), "original");
    expect(view).toEqual({ available: true, wrap: false, text: SOCKET, jsonFrom: "42/logger_server,".length });
  });

  it("wrapped original only changes wrapping", () => {
    const view = renderPreset("plain text", decode("plain text", "auto"), "wrapped");
    expect(view).toEqual({ available: true, wrap: true, text: "plain text", jsonFrom: null });
  });

  it("JSON presets need a payload", () => {
    const decoded = decode("plain text", "auto");
    expect(presetAvailable(decoded, "pretty")).toBe(false);
    expect(renderPreset("plain text", decoded, "compact").available).toBe(false);
    expect(payloadCopyText(decoded, "original")).toBeUndefined();
  });

  it("copy payload follows the preset", () => {
    const decoded = decode(SOCKET, "auto");
    expect(payloadCopyText(decoded, "wrapped")).toBe('["event",{"level":"info","msg":"<b>hi</b>"}]');
    expect(payloadCopyText(decoded, "pretty")).toBe('[\n  "event",\n  {\n    "level": "info",\n    "msg": "<b>hi</b>"\n  }\n]');
    expect(payloadCopyText(decoded, "compact")).toBe('["event",{"level":"info","msg":"<b>hi</b>"}]');
  });

  it("describes binary attachments without reconstructing them", () => {
    const facts = describeDecoded('451-["upload",{"_placeholder":true,"num":0}]', decode('451-["upload",{"_placeholder":true,"num":0}]', "socketio"));
    expect(facts.find((f) => f.key === "attachments")?.value).toContain("1 binary attachment(s) declared, 1 placeholder(s) found");
    expect(facts.find((f) => f.key === "event")?.value).toBe("upload");
  });
});

describe("session overrides", () => {
  it("keeps overrides per stream and direction, clears them on project change, and drops Auto choices", () => {
    const session = createSession();
    const client = { streamId: "1", direction: "CLIENT" } as const;
    session.setDecoder(client, { kind: "builtin", mode: "raw" });
    expect(session.decoderFor(client)).toEqual({ kind: "builtin", mode: "raw" });
    expect(session.decoderFor({ streamId: "1", direction: "SERVER" })).toEqual({ kind: "builtin", mode: "auto" });
    expect(session.decoderFor({ streamId: "2", direction: "CLIENT" })).toEqual({ kind: "builtin", mode: "auto" });
    session.changeProject("other");
    expect(session.decoderFor(client)).toEqual({ kind: "builtin", mode: "auto" });
    expect(session.overrideCount()).toBe(0);
    session.setDecoder(client, { kind: "builtin", mode: "json" });
    session.setDecoder(client, { kind: "builtin", mode: "auto" });
    expect(session.overrideCount()).toBe(0);
  });

  it("starts with no chosen preset", () => {
    expect(createSession().preset.value).toBeNull();
  });

  it("defaults to Pretty JSON with a payload and Wrapped original without one", () => {
    expect(defaultPreset(decode(SOCKET, "auto"))).toBe("pretty");
    expect(defaultPreset(decode("plain text", "auto"))).toBe("wrapped");
  });
});
