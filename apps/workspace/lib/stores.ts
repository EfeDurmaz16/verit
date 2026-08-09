import path from "node:path";
import { makeSqliteStores } from "@cyclops/adapter-sqlite";
import type { DocumentStore, SessionStore } from "@cyclops/ports";

/* Server-side singletons, opened lazily: importing a route module must not
   touch the database (`next build` collects page data in parallel workers, and
   they would race each other on the migration). The handle is cached on
   globalThis so dev-server module reloads reuse one connection. */

const SQLITE_PATH = process.env.CYCLOPS_SQLITE_PATH || ".data/cyclops.db";

/** Run blobs: prefetched PR data, the SpecStream log, the Understanding JSON. */
export const WORKSPACE_ROOT = path.resolve(
  process.env.CYCLOPS_WORKSPACE_DIR ?? ".data/workspace",
);

const g = globalThis as unknown as {
  __cyclopsStores?: ReturnType<typeof makeSqliteStores>;
};

const open = () => (g.__cyclopsStores ??= makeSqliteStores(SQLITE_PATH));

export const docs = (): DocumentStore => open().docs;
export const sessionStore = (): SessionStore => open().sessions;
