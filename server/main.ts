// Standalone server (optional). The demo uses `npm run dev`, which mounts
// this same API as a Vite middleware.
import { createServer } from 'node:http';
import { openDatabase, type DB } from './db.ts';
import { createApiHandler } from './api.ts';
import { isSeeded, seedDemo } from './seed.ts';

const dbPath = process.env.LED_DB_PATH ?? 'data/license-desk.sqlite';
const db: DB = openDatabase(dbPath);
if (!isSeeded(db)) seedDemo(db);

const handler = createApiHandler({ db, seeded: () => isSeeded(db) });
const port = Number(process.env.PORT ?? 5236);
createServer((req, res) => {
  void handler(req, res);
}).listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://127.0.0.1:${port}`);
});
