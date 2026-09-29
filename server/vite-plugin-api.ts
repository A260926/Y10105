// Vite dev plugin: mounts the API handler (and opens the SQLite database)
// inside the same dev server process, proxied under /api.

import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import { createApiHandler } from './api.ts';
import { openDatabase, type DB } from './db.ts';
import { seedDemo, isSeeded, CLOCK_NOW } from './seed.ts';

export const DB_PATH = process.env.LED_DB_PATH ?? 'data/license-desk.sqlite';

export function apiPlugin(): Plugin {
  let db: DB | null = null;
  return {
    name: 'license-exception-desk-api',
    configureServer(server: ViteDevServer) {
      db = openDatabase(DB_PATH);
      if (!isSeeded(db)) seedDemo(db);

      const handler = createApiHandler({
        db,
        seeded: () => isSeeded(db!),
      });

      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/')) {
          void handler(req as never, res as never).catch(next);
          return;
        }
        next();
      });

      server.httpServer?.once('close', () => db?.close());
    },
    configurePreviewServer(server: PreviewServer) {
      db = openDatabase(DB_PATH);
      if (!isSeeded(db)) seedDemo(db);
      const handler = createApiHandler({ db, seeded: () => isSeeded(db!) });
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/')) {
          void handler(req as never, res as never).catch(next);
          return;
        }
        next();
      });
    },
  };
}

export { CLOCK_NOW };
