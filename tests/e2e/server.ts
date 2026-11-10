import { createWebServer } from '../../src/web/server.js';
import type { StartupConfig } from '../../src/config.js';

// Real static serving/security headers, with all business/auth traffic intercepted
// by Playwright. Unmocked management traffic is deliberately denied.
const config: StartupConfig = {
  botToken: `12345:${'T'.repeat(35)}`, adminIds: [42], dataDir: '/tmp/misaka-unused-e2e',
  logLevel: 'silent', pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
  web: { enabled: true, host: '127.0.0.1', port: 4173, publicBaseUrl: 'https://127.0.0.1:4173',
    oidcClientId: '12345', oidcClientSecret: 'test-only-not-a-credential' },
};
const denied = async () => ({ status: 'rejected' as const, invocationId: 'unmocked', error: { code: 'FORBIDDEN' as const } });
const server = await createWebServer({ config, executor: { execute: denied, confirm: denied },
  access: { isAdmin: () => false }, botId: () => 12345,
  configuration: { resolveLanguage: () => 'en' },
});
const close = () => { void server.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
await server.listen({ host: '127.0.0.1', port: 4173 });
