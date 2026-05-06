import { spawnSync } from 'node:child_process';
import { BASE, PH } from '../shared/cookie.mjs';

export { BASE, PH };

function readWindowsUserEnvVar(name) {
  if (process.platform !== 'win32' || !name) return '';
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return '';
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = output.match(new RegExp(`\\b${name}\\b\\s+REG_\\w+\\s+(.+)$`, 'mi'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function getEnvValue(env, name, fallback = '') {
  const direct = env?.[name];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const fromUserEnv = readWindowsUserEnvVar(name);
  if (fromUserEnv) return fromUserEnv;
  return fallback;
}

export function createConfig(env = process.env) {
  return {
    renewBefore: (parseInt(env.RENEW_BEFORE) || 300) * 1000,
    checkInterval: (parseInt(env.CHECK_INTERVAL) || 60) * 1000,
    maxRetries: parseInt(env.MAX_RETRIES) || 5,
    deployRepo: env.DEPLOY_REPO || 'https://github.com/qindinp/keypool.git',
    keyExchangeUrl: env.KEY_EXCHANGE_URL || null,
    readyTimeout: 180_000,
    wsConnectTimeout: 30_000,
    deployTimeout: 300_000,
    chatTimeout: 120_000,
    retryBaseDelay: 5_000,
    retryMaxDelay: 60_000,
    tunnelType: env.TUNNEL_TYPE || 'tailscale',
    tunnelService: env.TUNNEL_SERVICE || 'localhost.run',
    tailscaleAuthKey: getEnvValue(env, 'TAILSCALE_AUTHKEY', ''),
    tailscaleHostname: getEnvValue(env, 'TAILSCALE_HOSTNAME', 'keypool'),
    tailscaleFunnel: getEnvValue(env, 'TAILSCALE_FUNNEL', 'true') !== 'false',
    tailscaleAutoInstall: getEnvValue(env, 'TAILSCALE_AUTO_INSTALL', 'true') !== 'false',
  };
}
