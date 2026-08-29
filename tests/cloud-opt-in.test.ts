/**
 * Cloud sync opt-in tests.
 *
 * Cloud sync must be strictly opt-in: with an empty `cloud_server_url` no data
 * leaves the device, and enabling cloud sync without a server URL is rejected.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-opt-in-'));
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
  now,
  createApp,
} = require('./helpers/test-setup');
const { settingsRoutes } = require('../main/routes/settings');
const { cloudSync, normalizeCloudServerUrl } = require('../main/services/cloud-sync');

function setSettings(entries: Record<string, string>) {
  const db = getDatabase();
  for (const [key, value] of Object.entries(entries)) {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now());
  }
}

async function run() {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  // Any outbound request during an opt-out state is a test failure.
  globalThis.fetch = (async () => {
    upstreamCalls++;
    throw new Error('unexpected outbound cloud request');
  }) as typeof fetch;

  try {
    initTestDb();
    const db = getDatabase();
    const owner = seedOwnerUser(db);
    const app = createApp({ '/api/settings': settingsRoutes });

    console.log('Cloud sync opt-in tests');

    // normalizeCloudServerUrl treats empty input as opt-out: returns '' and never throws.
    assertEqual(normalizeCloudServerUrl(''), '', 'normalizeCloudServerUrl returns empty string for empty input');
    assertEqual(normalizeCloudServerUrl('   '), '', 'normalizeCloudServerUrl trims whitespace to empty');
    assertEqual(
      normalizeCloudServerUrl('https://cloud.example.com/'),
      'https://cloud.example.com',
      'normalizeCloudServerUrl still normalizes a real URL',
    );

    // Empty cloud_server_url must not trigger any outbound request on startup/reload.
    setSettings({ cloud_server_url: '', cloud_sync_enabled: '0' });
    cloudSync.reload();
    cloudSync.maybeAutoRegister();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEqual(upstreamCalls, 0, 'no outbound cloud request when cloud_server_url is empty');

    // register() must refuse to run without a configured server URL and must not egress.
    let registerThrew = false;
    try {
      await cloudSync.register();
    } catch {
      registerThrew = true;
    }
    assert(registerThrew, 'register() throws when cloud_server_url is empty');
    assertEqual(upstreamCalls, 0, 'register() makes no outbound request without a server URL');

    // register() must not transmit business.email unless email_share_cloud is opted in.
    {
      let registerBody: any = null;
      const successFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/api/pos/register')) {
          registerBody = JSON.parse(String(init?.body || '{}'));
        }
        return new Response(
          JSON.stringify({ api_key: 'fac_live_test', store_id: '1', pos_id: 'pos_1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;
      const prevFetch = globalThis.fetch;
      globalThis.fetch = successFetch;
      try {
        // Default: email_share_cloud absent/0 → email must NOT be transmitted.
        setSettings({
          cloud_server_url: 'https://cloud.example.test',
          cloud_sync_enabled: '1',
          email_share_cloud: '0',
          email: 'owner@example.com',
          cloud_verification_welcome_requested: '1',
        });
        cloudSync.reload();
        await cloudSync.register();
        assertEqual(registerBody?.business?.email, '', 'register() omits business.email when email_share_cloud is not opted in');

        // Opted in: email IS transmitted.
        registerBody = null;
        setSettings({ email_share_cloud: '1' });
        cloudSync.reload();
        await cloudSync.register();
        assertEqual(registerBody?.business?.email, 'owner@example.com', 'register() sends business.email when email_share_cloud is opted in');
      } finally {
        globalThis.fetch = prevFetch;
        setSettings({ cloud_server_url: '', cloud_sync_enabled: '0', email_share_cloud: '0', cloud_registration_status: 'unregistered' });
        cloudSync.reload();
      }
    }

    // Enabling cloud sync without a server URL is rejected by the settings route.
    const enableNoUrl = await request(app)
      .put('/api/settings/cloud')
      .set(owner.authHeader)
      .send({ cloud_sync_enabled: true });
    assertEqual(enableNoUrl.status, 400, 'enabling cloud sync without a URL returns 400');
    assertEqual(
      getDatabase().prepare("SELECT value FROM settings WHERE key = 'cloud_sync_enabled'").get().value,
      '0',
      'cloud_sync_enabled stays disabled after a rejected enable request',
    );

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} cloud opt-in assertions failed`);
    console.log('✅ Cloud sync opt-in tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    cloudSync.stop();
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
