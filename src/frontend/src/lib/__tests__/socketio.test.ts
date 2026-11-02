import { parseEnginePacket, parseSocketPacket } from "../socketio";

describe("parseSocketPacket (protocol v5 examples)", () => {
  it.each([
    ['2["foo"]', { type: "EVENT", namespace: "/", eventName: "foo" }],
    ['2/admin,["bar"]', { type: "EVENT", namespace: "/admin", eventName: "bar" }],
    ['2/admin,1["tellme"]', { type: "EVENT", namespace: "/admin", eventName: "tellme", ackId: "1" }],
    ['3/admin,1["response"]', { type: "ACK", namespace: "/admin", ackId: "1" }],
    ["0", { type: "CONNECT", namespace: "/" }],
    ['0/admin,{"token":"123"}', { type: "CONNECT", namespace: "/admin" }],
    ["1/admin,", { type: "DISCONNECT", namespace: "/admin" }],
    ['4{"message":"Not authorized"}', { type: "CONNECT_ERROR", namespace: "/" }],
    ['51-["baz",{"_placeholder":true,"num":0}]', { type: "BINARY_EVENT", attachments: 1, placeholders: 1, eventName: "baz" }],
    ['61-/admin,1[{"_placeholder":true,"num":0}]', { type: "BINARY_ACK", attachments: 1, placeholders: 1, ackId: "1" }],
  ])("parses %s", (text, expected) => {
    const result = parseSocketPacket(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject(expected);
  });

  it("keeps the complete payload as an exact slice with every argument in order", () => {
    const text = '2/logger_server,["event",{"n":12345678901234567890},"x",[1]]';
    const result = parseSocketPacket(text, 1);
    expect(result.ok && result.value.payload?.text).toBe('["event",{"n":12345678901234567890},"x",[1]]');
    expect(result.ok && result.value.payload?.offset).toBe(1 + text.indexOf("["));
  });

  it.each([
    ['2"foo"', "EVENT payload must be an array"],
    ["2[1]", "event name string"],
    ["2[]", "event name string"],
    ['3["x"]', "requires an acknowledgment ID"],
    ['2/admin["x"]', "Namespace must end"],
    ['2["x"', "Invalid JSON"],
    ['51["x"]', "attachment count"],
    ['1["x"]', "DISCONNECT"],
    ["7", "type digit"],
    ['4"text"', "CONNECT_ERROR payload must be an object"],
  ])("rejects %s", (text, message) => {
    const result = parseSocketPacket(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });
});

describe("parseEnginePacket", () => {
  it("decodes a message carrying an event (screenshot shape)", () => {
    const result = parseEnginePacket('42/logger_server,["event",{"level":"info"}]');
    expect(result.ok && result.value).toMatchObject({ type: "message", socket: { type: "EVENT", namespace: "/logger_server", eventName: "event" } });
  });

  it("decodes the open handshake", () => {
    const result = parseEnginePacket('0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    expect(result.ok && result.value.type).toBe("open");
    expect(result.ok && result.value.handshake?.offset).toBe(1);
  });

  it.each([
    ["2", { type: "ping" }],
    ["3", { type: "pong" }],
    ["2probe", { type: "ping", data: "probe" }],
    ["3probe", { type: "pong", data: "probe" }],
    ["1", { type: "close" }],
    ["5", { type: "upgrade" }],
    ["6", { type: "noop" }],
    ["40", { type: "message", socket: { type: "CONNECT" } }],
  ])("decodes control %s", (text, expected) => {
    const result = parseEnginePacket(text);
    expect(result.ok && result.value).toMatchObject(expected);
  });

  it.each(["", "x", "7", "2hello", "1x", "0[]", "4", "42"])("rejects %s", (text) => {
    expect(parseEnginePacket(text).ok).toBe(false);
  });
});
