import { afterEach, describe, expect, test } from "bun:test";
import {
  makeMemoryObjectStore,
  setObjectStoreForTesting,
  type ObjectStore,
} from "./object-store.ts";
import { bustPublicPages, servePage } from "./page-cache.ts";

afterEach(() => setObjectStoreForTesting(null));

function withStore(): ObjectStore {
  const s = makeMemoryObjectStore();
  setObjectStoreForTesting(s);
  return s;
}

describe("servePage", () => {
  test("renders once, then serves from cache", async () => {
    withStore();
    let renders = 0;
    const render = async () => {
      renders++;
      return `body-${renders}`;
    };
    expect(await servePage("home", render)).toBe("body-1");
    expect(await servePage("home", render)).toBe("body-1"); // cached
    expect(renders).toBe(1);
  });

  test("re-renders once the TTL has lapsed", async () => {
    withStore();
    let renders = 0;
    const render = async () => `body-${++renders}`;
    expect(await servePage("home", render, 0)).toBe("body-1");
    expect(await servePage("home", render, 0)).toBe("body-2"); // ttl=0 → stale
    expect(renders).toBe(2);
  });

  test("null render means not-found and is not cached", async () => {
    const store = withStore();
    let renders = 0;
    const render = async () => {
      renders++;
      return null;
    };
    expect(await servePage("issue-99", render)).toBeNull();
    expect(await servePage("issue-99", render)).toBeNull();
    expect(renders).toBe(2); // never cached → rendered both times
    expect(await store.exists("cache/issue-99.json")).toBe(false);
  });

  test("falls back to render when the store throws", async () => {
    const broken: ObjectStore = {
      backend: "broken",
      get: async () => {
        throw new Error("down");
      },
      put: async () => {
        throw new Error("down");
      },
      exists: async () => false,
      delete: async () => {},
    };
    setObjectStoreForTesting(broken);
    expect(await servePage("home", async () => "live")).toBe("live");
  });
});

describe("bustPublicPages", () => {
  test("removes the public page keys", async () => {
    const store = withStore();
    await servePage("home", async () => "h");
    await servePage("feed", async () => "f");
    expect(await store.exists("cache/home.json")).toBe(true);
    expect(await store.exists("cache/feed.json")).toBe(true);
    await bustPublicPages();
    expect(await store.exists("cache/home.json")).toBe(false);
    expect(await store.exists("cache/feed.json")).toBe(false);
  });
});
