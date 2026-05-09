#!/usr/bin/env node
/**
 * KeyPool App — Manager + Gateway 联合启动
 *
 * 一键启动：
 *   node bin/app.mjs
 *
 * 环境变量：
 *   PORT                  - Gateway 端口 (默认 9300)
 *   HOST                  - Gateway 监听地址 (默认 0.0.0.0)
 *   ACCOUNTS_PATH         - 账号配置文件路径
 *   KEYPOOL_PUBLIC_WS_URL - 远端实例回连使用的公开 WebSocket 地址
 *   KEYPOOL_PUBLIC_HTTP_BASE - 远端实例下载 bundle 使用的公开 HTTP 基址
 */

import { createGateway } from '../src/gateway/index.mjs';
import { createManager } from '../src/manager/index.mjs';

const port = parseInt(process.env.PORT) || 9300;
const host = process.env.HOST || '0.0.0.0';
const accountsPath = process.env.ACCOUNTS_PATH || undefined;
const gatewayPublicWsUrl = process.env.KEYPOOL_PUBLIC_WS_URL || process.env.KEYPOOL_GATEWAY_URL || '';
const gatewayPublicHttpBase = process.env.KEYPOOL_PUBLIC_HTTP_BASE || process.env.KEYPOOL_GATEWAY_HTTP_BASE || '';

async function main() {
  console.log('🔑 KeyPool 启动中...');
  console.log(`   端口: ${port}`);
  console.log(`   地址: ${host}`);

  const gateway = createGateway({ port, host, manager: null });
  await gateway.start();

  const gatewayUrl = gatewayPublicWsUrl || `ws://127.0.0.1:${port}/ws`;
  const manager = createManager(gateway.registry, {
    accountsPath,
    gatewayUrl,
    gatewayHttpBase: gatewayPublicHttpBase || `http://127.0.0.1:${port}`,
    localSrcDir: process.env.LOCAL_SRC_DIR || '',
  });

  if (manager) {
    if (typeof gateway.setManager === 'function') gateway.setManager(manager);
    manager.start();
    console.log('✅ KeyPool 已就绪（Gateway + Manager）');
  } else {
    console.log('✅ KeyPool 已就绪（仅 Gateway 模式）');
    console.log('   配置 accounts.json 或 MIMO_COOKIE 后重启以启用 Manager');
  }

  const shutdown = () => {
    console.log('\n🛑 正在关闭...');
    if (manager) manager.stop();
    gateway.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
