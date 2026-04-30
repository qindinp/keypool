export const BASE = 'https://aistudio.xiaomimimo.com';
export const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';

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
  };
}
