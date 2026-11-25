import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteBackup, verifyDatabase } from '../tools/sqlite-backup.mjs';

test('SQLite backup: copy from active WAL database, verify and retain without touching source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adsl-sqlite-backup-'));
  const src = path.join(root, 'live.sqlite'), dir = path.join(root, 'backups');
  const db = new DatabaseSync(src);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_meta VALUES(\'schema_version\',\'3\'); CREATE TABLE router_card_days(day TEXT PRIMARY KEY); INSERT INTO router_card_days VALUES(\'2026-11-24\');');
  const r = createSqliteBackup({ database: src, directory: dir, keep: 2 });
  assert.equal(r.verification.ok, true);
  assert.equal(r.verification.schemaVersion, '3');
  assert.equal(r.verification.counts.router_card_days, 1);
  assert.equal(verifyDatabase(r.file).integrity, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_card_days').get().n, 1);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('SQLite backup: reject missing source and invalid retention', () => {
  assert.throws(() => createSqliteBackup({ database: '/no/such/file.sqlite' }), /غير موجودة/);
  assert.throws(() => createSqliteBackup({ database: '/no/such/file.sqlite', keep: 0 }), /غير صالح/);
});
