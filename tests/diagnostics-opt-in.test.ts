/**
 * Diagnostics opt-in tests.
 *
 * Tier 2 store-attributed diagnostics must be strictly opt-in: it defaults to
 * off (fresh and upgraded installs) and only leaves the device when the owner
 * has enabled diagnostics_consent AND configured cloud sync. With consent off,
 * reportDiagnostic() must not enqueue anything.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diag-opt-in-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const { cloudSync } = require('../main/services/cloud-sync');
const db = require('../main/db');

function setSettings(entries: Record<string, string>) {
  const d = getDatabase();
  for (const [key, value] of Object.entries(entries)) {
    d.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, db.now());
  }
}

function outboxCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS c FROM store_diagnostics_outbox').get() as { c: number }).c;
}

async function run() {
  const originalFetch = globalThis.fetch;
  // Any outbound request during these tests is a failure.
  globalThis.fetch = (async () => {
    throw new Error('unexpected outbound request');
  }) as typeof fetch;

  try {
    initTestDb();
    seedOwnerUser(getDatabase());
    void cloudSync;

    console.log('Diagnostics opt-in tests');

    // Fresh install defaults diagnostics_consent to off.
    assertEqual(
      getDatabase().prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent'").get().value,
      'false',
      'fresh install seeds diagnostics_consent = false',
    );
    assertEqual(db.isDiagnosticsConsentEnabled(), false, 'isDiagnosticsConsentEnabled() is false by default');

    // With consent off, reportDiagnostic must not enqueue anything.
    outboxCount() === 0;
    cloudSync.reportDiagnostic({ event_id: 'diag-off-1', payload: { note: 'should not persist' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEqual(outboxCount(), 0, 'no diagnostics enqueued while consent is off');

    // Enabling consent (and a configured, but not cloud-synced, store) enqueues.
    setSettings({ diagnostics_consent: 'true', cloud_sync_enabled: '0' });
    assertEqual(db.isDiagnosticsConsentEnabled(), true, 'isDiagnosticsConsentEnabled() is true after opt-in');
    cloudSync.reportDiagnostic({ event_id: 'diag-on-1', payload: { note: 'ok' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEqual(outboxCount(), 1, 'diagnostics enqueues once consent is given');

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} diagnostics opt-in assertions failed`);
    console.log('✅ Diagnostics opt-in tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    try { cloudSync.stop(); } catch { }
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
