// @ref LLP 0001#state — SQLite is the single source of truth for "seen";
// it is what makes "new since last check" survive restarts.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { paths } from './config.ts';

export interface PullRequestRow {
  id: string; // "<owner>/<repo>#<number>"
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  requested_at: string; // ISO
  first_seen_at: string; // ISO — when the sidecar first observed the request
  seen: number; // 0/1 — user marked as read
  state: string; // open | closed | merged
  updated_at: string; // ISO — PR updated_at from GitHub
}

export function openDb(file = paths.db): Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Upsert a PR; returns true when this is the first time the sidecar has seen it. */
export function upsertPr(db: Database, pr: Omit<PullRequestRow, 'first_seen_at' | 'seen'>): boolean {
  const existing = db.query<{ id: string }, [string]>('SELECT id FROM prs WHERE id = ?').get(pr.id);
  if (existing) {
    db.query(
      'UPDATE prs SET title = ?, url = ?, author = ?, requested_at = ?, state = ?, updated_at = ? WHERE id = ?',
    ).run(pr.title, pr.url, pr.author, pr.requested_at, pr.state, pr.updated_at, pr.id);
    return false;
  }
  db.query(
    'INSERT INTO prs (id, repo, number, title, url, author, requested_at, first_seen_at, seen, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
  ).run(
    pr.id,
    pr.repo,
    pr.number,
    pr.title,
    pr.url,
    pr.author,
    pr.requested_at,
    new Date().toISOString(),
    pr.state,
    pr.updated_at,
  );
  return true;
}

export function listPending(db: Database): PullRequestRow[] {
  return db
    .query<PullRequestRow, []>("SELECT * FROM prs WHERE state = 'open' ORDER BY requested_at DESC")
    .all();
}

export function markSeen(db: Database, id: string, seen: boolean): void {
  db.query('UPDATE prs SET seen = ? WHERE id = ?').run(seen ? 1 : 0, id);
}

export function closeMissing(db: Database, openIds: Set<string>): void {
  const rows = db.query<{ id: string }, []>("SELECT id FROM prs WHERE state = 'open'").all();
  for (const row of rows) {
    if (!openIds.has(row.id)) {
      db.query("UPDATE prs SET state = 'closed' WHERE id = ?").run(row.id);
    }
  }
}
