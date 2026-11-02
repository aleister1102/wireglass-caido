import { findNodeAtLocation, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import type { KVSDK, KVValue } from "@caido/sdk-frontend";
import type { Layout, LayoutIssue } from "./types";
import { checkLayoutFileSize, decodeLayoutBytes, jsonPointer, validateLayoutText } from "./validate";

export const CATALOG_KEY = "layout-catalog";
export const CATALOG_FORMAT_VERSION = 1;

/** The kv methods the catalog uses. The Caido `sdk.kv` object satisfies this. */
export type CatalogStorage = Pick<KVSDK, "define" | "get" | "set">;

/** The registry methods the catalog keeps in sync. `useLayoutRegistry()` satisfies this. */
export type CatalogRegistry = {
  install(layout: Layout): void;
  remove(id: string): boolean;
  replaceAll(layouts: Layout[]): void;
};

/** A file chosen in the browser. Only `size` and `arrayBuffer()` are read. */
export type LayoutFile = { readonly size: number; arrayBuffer(): Promise<ArrayBuffer> };

/** An installed entry that failed validation on load or on import. */
export type EntryView =
  | { readonly index: number; readonly status: "valid"; readonly id: string; readonly name: string; readonly version: number }
  | { readonly index: number; readonly status: "invalid"; readonly id?: string; readonly issues: readonly LayoutIssue[] };

export type CatalogView = {
  readonly ready: boolean;
  /** Set when the stored catalog could not be read; changes are blocked. */
  readonly readError?: string;
  /** Set when the stored value is not a version 1 envelope; it is replaced by the next change. */
  readonly envelopeError?: string;
  readonly entries: readonly EntryView[];
};

export type StagedLayout = {
  readonly layout: Layout;
  readonly raw: KVValue;
  /** The installed layout this item replaces, captured when the change was staged. */
  readonly replaces?: { readonly name: string; readonly version: number };
};

/** A change that was validated and is waiting for user confirmation. */
export type StagedChange = { readonly kind: "install" | "import"; readonly items: readonly StagedLayout[] };

export type StageResult = { ok: true; change: StagedChange } | { ok: false; issues: readonly LayoutIssue[] };
export type CommitResult = { ok: true } | { ok: false; error: string };

export type LayoutCatalog = {
  load(): Promise<void>;
  view(): CatalogView;
  subscribe(callback: () => void): () => void;
  stageFile(file: LayoutFile): Promise<StageResult>;
  stageImport(file: LayoutFile): Promise<StageResult>;
  /** Writes first, then updates memory and the registry. Replacing needs `confirmed: true`. */
  commit(change: StagedChange, options: { confirmed: boolean }): Promise<CommitResult>;
  /** `expected` is the entry the user saw; a changed entry at that index is refused. */
  remove(expected: EntryView): Promise<CommitResult>;
  exportText(): string;
};

type Slot =
  | { readonly status: "valid"; readonly raw: KVValue; readonly layout: Layout }
  | { readonly status: "invalid"; readonly raw: unknown; readonly issues: readonly LayoutIssue[] };

type Options = {
  storage: CatalogStorage;
  registry: CatalogRegistry;
};

const ok: CommitResult = { ok: true };
const fail = (error: string): CommitResult => ({ ok: false, error });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(raw: unknown): string | undefined {
  return isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
}

/** Issue pointers for an entry are reported under its position in the envelope. */
function prefixed(index: number, issues: readonly LayoutIssue[], base = 0): LayoutIssue[] {
  return issues.map((issue) => ({
    ...issue,
    pointer: `/layouts/${index}${issue.pointer}`,
    ...(issue.offset === undefined ? {} : { offset: issue.offset + base }),
  }));
}

function envelopeIssue(pointer: string, text: string): LayoutIssue {
  return { code: "invalid-file", pointer, message: text };
}

function slotsToView(slots: readonly Slot[]): EntryView[] {
  return slots.map((slot, index): EntryView => {
    if (slot.status === "valid") {
      return { index, status: "valid", id: slot.layout.id, name: slot.layout.name, version: slot.layout.version };
    }
    const id = idOf(slot.raw);
    return id === undefined ? { index, status: "invalid", issues: slot.issues } : { index, status: "invalid", id, issues: slot.issues };
  });
}

function validSlots(slots: readonly Slot[]): Extract<Slot, { status: "valid" }>[] {
  return slots.filter((slot): slot is Extract<Slot, { status: "valid" }> => slot.status === "valid");
}

/** Validates one stored or imported entry. Duplicate IDs among valid entries are rejected. */
function slotFromRaw(raw: unknown, index: number, seen: Set<string>): Slot {
  const validation = validateLayoutText(JSON.stringify(raw) ?? "");
  if (!validation.ok) return { status: "invalid", raw, issues: prefixed(index, validation.issues) };
  if (seen.has(validation.layout.id)) {
    const issue = envelopeIssue(`/layouts/${index}/id`, `duplicate layout id "${validation.layout.id}"`);
    return { status: "invalid", raw, issues: [issue] };
  }
  seen.add(validation.layout.id);
  return { status: "valid", raw: raw as KVValue, layout: validation.layout };
}

/** Parses the stored value. A non-envelope value yields an envelope error and no entries. */
function slotsFromStored(stored: unknown): { slots: Slot[]; envelopeError?: string } {
  if (stored === undefined) return { slots: [] };
  if (!isPlainObject(stored) || stored.formatVersion !== CATALOG_FORMAT_VERSION || !Array.isArray(stored.layouts)) {
    return { slots: [], envelopeError: "The stored catalog is not a version 1 envelope. It is ignored, and the next change replaces it." };
  }
  const seen = new Set<string>();
  return { slots: stored.layouts.map((raw, index) => slotFromRaw(raw, index, seen)) };
}

function envelopeOf(slots: readonly Slot[]): KVValue {
  return { formatVersion: CATALOG_FORMAT_VERSION, layouts: slots.map((slot) => slot.raw as KVValue) };
}

/**
 * Reads an import file. Each entry is validated from its own source text, so duplicate keys inside
 * an entry are rejected by the layout validator.
 */
function parseImportText(text: string): { ok: true; items: { layout: Layout; raw: KVValue }[] } | { ok: false; issues: LayoutIssue[] } {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true });
  if (errors.length > 0 || !root) {
    const first = errors[0];
    return { ok: false, issues: [{ code: "invalid-json", pointer: "", message: first ? printParseErrorCode(first.error) : "invalid JSON", offset: first?.offset }] };
  }
  if (root.type !== "object") return { ok: false, issues: [envelopeIssue("", "the file must be a JSON object")] };

  const issues: LayoutIssue[] = [];
  const keys = new Set<string>();
  for (const property of root.children ?? []) {
    const key = String(property.children?.[0]?.value);
    if (keys.has(key)) issues.push({ code: "duplicate-key", pointer: jsonPointer([key]), message: `duplicate key "${key}"` });
    keys.add(key);
    if (key !== "formatVersion" && key !== "layouts") {
      issues.push({ code: "unknown-key", pointer: jsonPointer([key]), message: `unknown key "${key}"` });
    }
  }
  const versionNode: Node | undefined = findNodeAtLocation(root, ["formatVersion"]);
  if (!versionNode) issues.push(envelopeIssue("/formatVersion", "missing formatVersion"));
  else if (versionNode.value !== CATALOG_FORMAT_VERSION) issues.push(envelopeIssue("/formatVersion", "formatVersion must be 1"));
  const layoutsNode = findNodeAtLocation(root, ["layouts"]);
  if (!layoutsNode) issues.push(envelopeIssue("/layouts", "missing layouts"));
  else if (layoutsNode.type !== "array") issues.push(envelopeIssue("/layouts", "layouts must be an array"));
  if (issues.length > 0 || !layoutsNode) return { ok: false, issues };

  const items: { layout: Layout; raw: KVValue }[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (layoutsNode.children ?? []).entries()) {
    const slice = text.slice(entry.offset, entry.offset + entry.length);
    const validation = validateLayoutText(slice);
    if (!validation.ok) {
      issues.push(...prefixed(index, validation.issues, entry.offset));
      continue;
    }
    if (seen.has(validation.layout.id)) {
      issues.push(envelopeIssue(`/layouts/${index}/id`, `duplicate layout id "${validation.layout.id}"`));
      continue;
    }
    seen.add(validation.layout.id);
    items.push({ layout: validation.layout, raw: JSON.parse(slice) as KVValue });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, items };
}

async function readFile(file: LayoutFile): Promise<{ ok: true; text: string } | { ok: false; issues: LayoutIssue[] }> {
  const tooLarge = checkLayoutFileSize(file.size);
  if (tooLarge) return { ok: false, issues: [tooLarge] };
  const decoded = decodeLayoutBytes(new Uint8Array(await file.arrayBuffer()));
  return decoded.ok ? { ok: true, text: decoded.text } : { ok: false, issues: [decoded.issue] };
}

export function createLayoutCatalog({ storage, registry }: Options): LayoutCatalog {
  let slots: Slot[] = [];
  let ready = false;
  let readError: string | undefined;
  let envelopeError: string | undefined;
  let current: CatalogView = { ready, entries: [] };
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();

  function publish() {
    current = { ready, readError, envelopeError, entries: slotsToView(slots) };
    for (const listener of listeners) listener();
  }

  /** Runs catalog mutations one at a time so each staged check sees the previous write. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  /** Writes the next envelope; memory is swapped only after the write succeeds. */
  async function persist(next: Slot[]): Promise<CommitResult> {
    if (readError !== undefined) return fail(`The stored catalog could not be read (${readError}). Changes are blocked.`);
    try {
      await storage.set(CATALOG_KEY, envelopeOf(next));
    } catch (error) {
      return fail(`Could not save the catalog: ${message(error)}. The previous catalog is unchanged.`);
    }
    slots = next;
    envelopeError = undefined;
    publish();
    return ok;
  }

  function itemFor(layout: Layout, raw: KVValue): StagedLayout {
    const existing = validSlots(slots).find((slot) => slot.layout.id === layout.id);
    return existing
      ? { layout, raw, replaces: { name: existing.layout.name, version: existing.layout.version } }
      : { layout, raw };
  }

  return {
    async load() {
      try {
        await storage.define(CATALOG_KEY, { exportable: false });
        const stored = await storage.get(CATALOG_KEY);
        const parsed = slotsFromStored(stored);
        slots = parsed.slots;
        envelopeError = parsed.envelopeError;
      } catch (error) {
        readError = message(error);
        slots = [];
      }
      ready = true;
      registry.replaceAll(validSlots(slots).map((slot) => slot.layout));
      publish();
    },

    view: () => current,

    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    async stageFile(file) {
      const read = await readFile(file);
      if (!read.ok) return { ok: false, issues: read.issues };
      const validation = validateLayoutText(read.text);
      if (!validation.ok) return { ok: false, issues: validation.issues };
      const raw = JSON.parse(read.text) as KVValue;
      return { ok: true, change: { kind: "install", items: [itemFor(validation.layout, raw)] } };
    },

    async stageImport(file) {
      const read = await readFile(file);
      if (!read.ok) return { ok: false, issues: read.issues };
      const parsed = parseImportText(read.text);
      if (!parsed.ok) return { ok: false, issues: parsed.issues };
      return { ok: true, change: { kind: "import", items: parsed.items.map((item) => itemFor(item.layout, item.raw)) } };
    },

    commit(change, { confirmed }) {
      return serial(async () => {
        if (change.items.some((item) => item.replaces) && !confirmed) {
          return fail("Replacing an installed layout needs confirmation.");
        }
        const next = [...slots];
        for (const item of change.items) {
          const index = next.findIndex((slot) => slot.status === "valid" && slot.layout.id === item.layout.id);
          if (index < 0) {
            if (item.replaces) return fail("The installed layout changed since it was reviewed. Start the install again.");
            next.push({ status: "valid", raw: item.raw, layout: item.layout });
            continue;
          }
          const existing = next[index] as Extract<Slot, { status: "valid" }>;
          if (!item.replaces || existing.layout.name !== item.replaces.name || existing.layout.version !== item.replaces.version) {
            return fail("The installed layout changed since it was reviewed. Start the install again.");
          }
          next[index] = { status: "valid", raw: item.raw, layout: item.layout };
        }
        const result = await persist(next);
        if (!result.ok) return result;
        for (const item of change.items) registry.install(item.layout);
        return ok;
      });
    },

    remove(expected) {
      return serial(async () => {
        const slot = slots[expected.index];
        const matches =
          slot !== undefined &&
          (expected.status === "valid"
            ? slot.status === "valid" &&
              slot.layout.id === expected.id &&
              slot.layout.name === expected.name &&
              slot.layout.version === expected.version
            : slot.status === "invalid" && idOf(slot.raw) === expected.id);
        if (!matches) return fail("The catalog changed since this entry was shown. Refresh and try again.");
        const result = await persist(slots.filter((_, index) => index !== expected.index));
        if (!result.ok) return result;
        if (expected.status === "valid") {
          registry.remove(expected.id);
        }
        return ok;
      });
    },

    exportText() {
      return JSON.stringify({ formatVersion: CATALOG_FORMAT_VERSION, layouts: validSlots(slots).map((slot) => slot.raw) }, null, 2);
    },
  };
}
