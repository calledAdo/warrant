import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const databasePath = process.env.WARRANT_DB || 'data/warrant.db';
mkdirSync(dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (
 thread TEXT NOT NULL, ns TEXT NOT NULL, id TEXT NOT NULL, parent TEXT,
 type TEXT NOT NULL, value BLOB NOT NULL, metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
 PRIMARY KEY(thread, ns, id));
CREATE TABLE IF NOT EXISTS checkpoint_writes (
 thread TEXT NOT NULL, ns TEXT NOT NULL, checkpoint TEXT NOT NULL,
 task TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL, value BLOB NOT NULL,
 PRIMARY KEY(thread, ns, checkpoint, task, idx));
CREATE INDEX IF NOT EXISTS checkpoints_thread_ns_id ON checkpoints(thread,ns,id DESC);
CREATE INDEX IF NOT EXISTS checkpoint_writes_lookup ON checkpoint_writes(thread,ns,checkpoint);`);
