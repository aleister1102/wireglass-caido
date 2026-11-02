import type { Layout } from "./types";

export type LayoutSummary = { id: string; name: string; version: number; revision: number };

export interface LayoutRegistry {
  list(): LayoutSummary[];
  get(id: string): Layout | undefined;
  revision(): number;
  subscribe(callback: () => void): () => void;
  install(layout: Layout): void;
  remove(id: string): boolean;
  replaceAll(layouts: Layout[]): void;
}

type Entry = { layout: Layout; revision: number };

/** `revision` is the registry revision at which a layout was last installed or replaced. */
export function createLayoutRegistry(): LayoutRegistry {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let current = 0;

  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const put = (layout: Layout) => entries.set(layout.id, { layout, revision: current });

  return {
    list: () =>
      [...entries.values()].map(({ layout, revision }) => ({ id: layout.id, name: layout.name, version: layout.version, revision })),
    get: (id) => entries.get(id)?.layout,
    revision: () => current,
    subscribe(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    install(layout) {
      current++;
      put(layout);
      changed();
    },
    remove(id) {
      if (!entries.delete(id)) return false;
      current++;
      changed();
      return true;
    },
    replaceAll(layouts) {
      current++;
      entries.clear();
      for (const layout of layouts) put(layout);
      changed();
    },
  };
}

let singleton: LayoutRegistry | undefined;

/** The process-wide registry; the catalog loads it and the inspector reads it. */
export function useLayoutRegistry(): LayoutRegistry {
  singleton ??= createLayoutRegistry();
  return singleton;
}
