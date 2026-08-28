/**
 * Tax-pack catalog consent tests.
 *
 * Catalog and update checks against the upstream tax-pack repository must be
 * strictly opt-in: with `tax_pack_catalog_consent` off (the default for fresh
 * and upgraded installs) the catalog and updates endpoints refuse with 403 and
 * never contact the upstream repository. With consent on, the gate opens and
 * the route proceeds (the upstream fetch itself may fail offline, but it must
 * not be the consent-refusal 403).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-taxpack-consent-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  createApp,
} = require('./helpers/test-setup');
const db = require('../main/db');
const { taxPackRoutes } = require('../main/routes/tax-packs');

function setConsent(enabled: boolean) {
  const d = getDatabase();
  d.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('tax_pack_catalog_consent', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(enabled ? 'true' : 'false', db.now());
}

async function run() {
  const originalFetch = globalThis.fetch;
  // Any outbound request while consent is OFF is a test failure; while ON we
  // let it throw so the route surfaces a 502 instead of reaching the network.
  globalThis.fetch = (async () => {
    throw new Error('unexpected outbound catalog request');
  }) as typeof fetch;

  try {
    initTestDb();
    const d = getDatabase();
    const owner = seedOwnerUser(d);
    const app = createApp({ '/api/tax-packs': taxPackRoutes });

    console.log('Tax-pack catalog consent tests');

    // Fresh install seeds tax_pack_catalog_consent = false.
    assertEqual(
      d.prepare("SELECT value FROM settings WHERE key = 'tax_pack_catalog_consent'").get().value,
      'false',
      'fresh install seeds tax_pack_catalog_consent = false',
    );
    assertEqual(db.isTaxPackCatalogConsentEnabled(), false, 'isTaxPackCatalogConsentEnabled() is false by default');

    // Without consent, the catalog and updates endpoints must refuse with 403.
    const offCatalog = await request(app).get('/api/tax-packs/catalog').set(owner.authHeader);
    assertEqual(offCatalog.status, 403, 'GET /tax-packs/catalog returns 403 when catalog consent is off');
    assertEqual(
      offCatalog.body?.error,
      'tax_pack_catalog_consent_required',
      'catalog 403 reports the consent-required error code',
    );

    const offUpdates = await request(app).get('/api/tax-packs/updates').set(owner.authHeader);
    assertEqual(offUpdates.status, 403, 'GET /tax-packs/updates returns 403 when catalog consent is off');
    assertEqual(
      offUpdates.body?.error,
      'tax_pack_catalog_consent_required',
      'updates 403 reports the consent-required error code',
    );

    // With consent on, the gate opens and the route proceeds (offline fetch
    // fails with 502, but it must not be the consent-refusal 403).
    setConsent(true);
    assertEqual(db.isTaxPackCatalogConsentEnabled(), true, 'isTaxPackCatalogConsentEnabled() is true after opt-in');

    const onCatalog = await request(app).get('/api/tax-packs/catalog').set(owner.authHeader);
    assert(onCatalog.status !== 403, `catalog proceeds past the consent gate when enabled (got ${onCatalog.status})`);

    const onUpdates = await request(app).get('/api/tax-packs/updates').set(owner.authHeader);
    assert(onUpdates.status !== 403, `updates proceeds past the consent gate when enabled (got ${onUpdates.status})`);

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} tax-pack catalog consent assertions failed`);
    console.log('✅ Tax-pack catalog consent tests passed');
  } finally {
    globalThis.fetch = originalFetch;
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
