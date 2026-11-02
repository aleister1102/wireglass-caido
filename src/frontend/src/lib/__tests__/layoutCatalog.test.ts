// @vitest-environment node
import { MAX_FILE_BYTES, type Layout } from "../layout";
import {
  createLayoutCatalog,
  type CatalogRegistry,
  type CatalogStorage,
  type EntryView,
  type LayoutCatalog,
  type LayoutFile,
} from "../layout/catalog";

const KEY = "layout-catalog";

function layout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    id: "sample",
    name: "Sample",
    version: 1,
    fields: [{ name: "magic", type: "u16", endian: "be", expect: 17232 }],
    ...overrides,
  };
}

function text(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(layout(overrides));
}

function envelope(...entries: unknown[]): string {
  return JSON.stringify({ formatVersion: 1, layouts: entries });
}

function fileOf(source: string): LayoutFile {
  const bytes = new TextEncoder().encode(source);
  return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer };
}

/** In-memory kv. Values are JSON clones, so callers cannot alias stored state. */
function fakeKv(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [[KEY, initial]]);
  const failure: { next?: Error; reads?: Error } = {};
  const storage: CatalogStorage = {
    define: vi.fn(async () => undefined),
    get: vi.fn(async (key: string) => {
      if (failure.reads) throw failure.reads;
      const value = values.get(key);
      return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as never);
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      if (failure.next) {
        const error = failure.next;
        failure.next = undefined;
        throw error;
      }
      values.set(key, JSON.parse(JSON.stringify(value)));
    }),
  };
  return { storage, values, failure };
}

function fakeRegistry() {
  const installed = new Map<string, Layout>();
  const registry: CatalogRegistry = {
    install: vi.fn((next: Layout) => {
      installed.set(next.id, next);
    }),
    remove: vi.fn((id: string) => installed.delete(id)),
    replaceAll: vi.fn((next: Layout[]) => {
      installed.clear();
      for (const item of next) installed.set(item.id, item);
    }),
  };
  return { installed, registry };
}

async function loaded(initial?: unknown) {
  const kv = fakeKv(initial);
  const reg = fakeRegistry();
  const catalog = createLayoutCatalog({ storage: kv.storage, registry: reg.registry });
  await catalog.load();
  return { catalog, kv, ...reg };
}

async function installText(catalog: LayoutCatalog, source: string) {
  const staged = await catalog.stageFile(fileOf(source));
  if (!staged.ok) throw new Error(`stage failed: ${JSON.stringify(staged.issues)}`);
  return catalog.commit(staged.change, { confirmed: true });
}

describe("layout catalog load", () => {
  it("starts empty and defines the key as non-exportable", async () => {
    const { catalog, kv, installed, registry } = await loaded();

    expect(kv.storage.define).toHaveBeenCalledWith(KEY, { exportable: false });
    expect(catalog.view()).toEqual({ ready: true, readError: undefined, envelopeError: undefined, entries: [] });
    expect(registry.replaceAll).toHaveBeenCalledWith([]);
    expect(installed.size).toBe(0);
  });

  it("keeps valid entries when one stored entry is corrupted and reports it per entry", async () => {
    const stored = JSON.parse(envelope(JSON.parse(text({ id: "a" })), { id: "broken", format: 9 }, JSON.parse(text({ id: "c" }))));
    const { catalog, installed, kv } = await loaded(stored);

    const entries = catalog.view().entries;
    expect(entries.map((entry) => entry.status)).toEqual(["valid", "invalid", "valid"]);
    expect(entries[1]).toMatchObject({ index: 1, status: "invalid", id: "broken" });
    if (entries[1]?.status !== "invalid") throw new Error("expected invalid entry");
    expect(entries[1].issues.length).toBeGreaterThan(0);
    expect(entries[1].issues.every((issue) => issue.pointer.startsWith("/layouts/1"))).toBe(true);
    expect([...installed.keys()].sort()).toEqual(["a", "c"]);

    // The corrupted entry is kept as stored until the user removes it.
    await installText(catalog, text({ id: "d" }));
    expect((kv.values.get(KEY) as { layouts: unknown[] }).layouts).toHaveLength(4);
  });

  it("refuses a duplicate id among stored entries and keeps the first", async () => {
    const stored = JSON.parse(envelope(JSON.parse(text({ id: "same" })), JSON.parse(text({ id: "same", version: 2 }))));
    const { catalog, installed } = await loaded(stored);

    expect(catalog.view().entries.map((entry) => entry.status)).toEqual(["valid", "invalid"]);
    expect(installed.get("same")?.version).toBe(1);
  });

  it("ignores a stored value that is not a version 1 envelope and reports it", async () => {
    const { catalog, installed } = await loaded({ formatVersion: 2, layouts: [] });

    expect(catalog.view().envelopeError).toMatch(/not a version 1 envelope/);
    expect(catalog.view().entries).toEqual([]);
    expect(installed.size).toBe(0);
  });

  it("blocks changes when the stored catalog cannot be read", async () => {
    const kv = fakeKv(JSON.parse(envelope()));
    kv.failure.reads = new Error("storage offline");
    const reg = fakeRegistry();
    const catalog = createLayoutCatalog({ storage: kv.storage, registry: reg.registry });
    await catalog.load();

    expect(catalog.view().readError).toBe("storage offline");
    const staged = await catalog.stageFile(fileOf(text()));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const result = await catalog.commit(staged.change, { confirmed: true });
    expect(result).toMatchObject({ ok: false });
    expect(kv.storage.set).not.toHaveBeenCalled();
  });
});

describe("install", () => {
  it("writes the envelope, then updates memory and the registry", async () => {
    const { catalog, kv, installed, registry } = await loaded();
    const listener = vi.fn();
    catalog.subscribe(listener);

    const result = await installText(catalog, text({ id: "sample", version: 1 }));

    expect(result).toEqual({ ok: true });
    expect(kv.values.get(KEY)).toEqual({ formatVersion: 1, layouts: [JSON.parse(text())] });
    expect(registry.install).toHaveBeenCalledWith(expect.objectContaining({ id: "sample", version: 1 }));
    expect(installed.get("sample")?.version).toBe(1);
    expect(catalog.view().entries).toEqual([{ index: 0, status: "valid", id: "sample", name: "Sample", version: 1 }]);
    expect(listener).toHaveBeenCalled();
  });

  it("names the old and new version when staging a replacement and refuses it without confirmation", async () => {
    const { catalog, kv, installed } = await loaded();
    await installText(catalog, text({ id: "sample", version: 1 }));

    const staged = await catalog.stageFile(fileOf(text({ id: "sample", version: 2, name: "Sample two" })));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.change.items[0]?.replaces).toEqual({ name: "Sample", version: 1 });

    expect(await catalog.commit(staged.change, { confirmed: false })).toMatchObject({ ok: false });
    expect(installed.get("sample")?.version).toBe(1);

    expect(await catalog.commit(staged.change, { confirmed: true })).toEqual({ ok: true });
    expect(installed.get("sample")?.version).toBe(2);
    expect((kv.values.get(KEY) as { layouts: { version: number }[] }).layouts).toEqual([expect.objectContaining({ version: 2 })]);
  });

  it("keeps the old catalog when the write fails", async () => {
    const { catalog, kv, installed, registry } = await loaded();
    await installText(catalog, text({ id: "sample", version: 1 }));
    const before = JSON.stringify(kv.values.get(KEY));
    const listener = vi.fn();
    catalog.subscribe(listener);

    const staged = await catalog.stageFile(fileOf(text({ id: "sample", version: 2 })));
    if (!staged.ok) throw new Error("stage failed");
    kv.failure.next = new Error("disk full");
    const result = await catalog.commit(staged.change, { confirmed: true });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("disk full") });
    expect(JSON.stringify(kv.values.get(KEY))).toBe(before);
    expect(installed.get("sample")?.version).toBe(1);
    expect(registry.install).toHaveBeenCalledTimes(1);
    expect(catalog.view().entries[0]).toMatchObject({ status: "valid", version: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("refuses an install whose id was installed after the file was staged", async () => {
    const { catalog } = await loaded();
    const staged = await catalog.stageFile(fileOf(text({ id: "sample", version: 1 })));
    if (!staged.ok) throw new Error("stage failed");
    await installText(catalog, text({ id: "sample", version: 3 }));

    const result = await catalog.commit(staged.change, { confirmed: true });
    expect(result).toMatchObject({ ok: false });
    expect(catalog.view().entries).toHaveLength(1);
    expect(catalog.view().entries[0]).toMatchObject({ version: 3 });
  });

  it("rejects a file over the size limit before reading it", async () => {
    const { catalog } = await loaded();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));

    const staged = await catalog.stageFile({ size: MAX_FILE_BYTES + 1, arrayBuffer });

    expect(staged.ok).toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an invalid layout file and writes nothing", async () => {
    const { catalog, kv, registry } = await loaded();

    const staged = await catalog.stageFile(fileOf(text({ format: 2 })));

    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.issues.length).toBeGreaterThan(0);
    expect(kv.storage.set).not.toHaveBeenCalled();
    expect(registry.install).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("removes the definition", async () => {
    const { catalog, kv, installed, registry } = await loaded();
    await installText(catalog, text({ id: "sample" }));
    const entry = catalog.view().entries[0] as EntryView;

    expect(await catalog.remove(entry)).toEqual({ ok: true });

    expect(kv.values.get(KEY)).toEqual({ formatVersion: 1, layouts: [] });
    expect(registry.remove).toHaveBeenCalledWith("sample");
    expect(installed.size).toBe(0);
  });

  it("refuses to remove an entry whose version changed after it was shown", async () => {
    const { catalog, kv, installed } = await loaded();
    await installText(catalog, text({ id: "sample", version: 1 }));
    const shown = catalog.view().entries[0] as EntryView;
    const replaced = await catalog.stageFile(fileOf(text({ id: "sample", version: 2 })));
    if (!replaced.ok) throw new Error("stage failed");
    await catalog.commit(replaced.change, { confirmed: true });

    expect(await catalog.remove(shown)).toMatchObject({ ok: false });
    expect(installed.get("sample")?.version).toBe(2);
    expect(kv.values.get(KEY)).toEqual({ formatVersion: 1, layouts: [JSON.parse(text({ id: "sample", version: 2 }))] });
  });

  it("removes a corrupted entry without touching valid ones", async () => {
    const stored = JSON.parse(envelope(JSON.parse(text({ id: "a" })), { id: "broken", format: 9 }));
    const { catalog, kv, installed } = await loaded(stored);
    const broken = catalog.view().entries[1] as EntryView;

    expect(await catalog.remove(broken)).toEqual({ ok: true });

    expect(kv.values.get(KEY)).toEqual({ formatVersion: 1, layouts: [JSON.parse(text({ id: "a" }))] });
    expect([...installed.keys()]).toEqual(["a"]);
  });

  it("keeps the entry when the write fails", async () => {
    const { catalog, kv, installed, registry } = await loaded();
    await installText(catalog, text({ id: "sample" }));
    kv.failure.next = new Error("write refused");

    const result = await catalog.remove(catalog.view().entries[0] as EntryView);

    expect(result).toMatchObject({ ok: false });
    expect(installed.has("sample")).toBe(true);
    expect(registry.remove).not.toHaveBeenCalled();
    expect(catalog.view().entries).toHaveLength(1);
  });
});

describe("import and export", () => {
  it("round-trips the exported catalog to identical stored content", async () => {
    const source = await loaded();
    await installText(source.catalog, text({ id: "one", version: 1 }));
    await installText(source.catalog, text({ id: "two", version: 4, name: "Two" }));
    const exported = source.catalog.exportText();

    const target = await loaded();
    const staged = await target.catalog.stageImport(fileOf(exported));
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.change.kind).toBe("import");
    expect(await target.catalog.commit(staged.change, { confirmed: false })).toEqual({ ok: true });

    expect(target.kv.values.get(KEY)).toEqual(source.kv.values.get(KEY));
    expect(target.catalog.exportText()).toBe(exported);
    expect([...target.installed.keys()].sort()).toEqual(["one", "two"]);
  });

  it("refuses the whole import when one entry is invalid", async () => {
    const { catalog, kv } = await loaded();
    const source = envelope(JSON.parse(text({ id: "good" })), { id: "bad", format: 3 });

    const staged = await catalog.stageImport(fileOf(source));

    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.issues.some((issue) => issue.pointer.startsWith("/layouts/1"))).toBe(true);
    expect(kv.storage.set).not.toHaveBeenCalled();
  });

  it("refuses an import with an unknown top-level key", async () => {
    const { catalog } = await loaded();
    const staged = await catalog.stageImport(fileOf(JSON.stringify({ formatVersion: 1, layouts: [], extra: true })));
    expect(staged.ok).toBe(false);
  });

  it("requires confirmation for an import that replaces an installed layout", async () => {
    const { catalog, installed } = await loaded();
    await installText(catalog, text({ id: "one", version: 1 }));

    const staged = await catalog.stageImport(fileOf(envelope(JSON.parse(text({ id: "one", version: 2 })))));
    if (!staged.ok) throw new Error("stage failed");
    expect(staged.change.items[0]?.replaces).toEqual({ name: "Sample", version: 1 });
    expect(await catalog.commit(staged.change, { confirmed: false })).toMatchObject({ ok: false });
    expect(installed.get("one")?.version).toBe(1);
  });
});
