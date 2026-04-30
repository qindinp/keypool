/**
 * KeyPool — 配置加载 & OpenClaw 自动检测
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/** 尝试从 JSONC 中提取配置（去掉注释、尾逗号） */
function parseJsonc(text) {
  let cleaned = text
    .replace(/\/\/.*$/gm, '')          // 单行注释
    .replace(/\/\*[\s\S]*?\*\//g, '')  // 多行注释
    .replace(/,(\s*[}\]])/g, '$1');    // 尾逗号
  return JSON.parse(cleaned);
}

/** 解析环境变量引用 ${VAR_NAME} */
function resolveEnvVars(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

/** 读取 OpenClaw 配置文件 */
function readOpenClawConfig() {
  const candidates = [
    join(homedir(), '.openclaw', 'openclaw.json'),
    process.env.OPENCLAW_CONFIG && resolve(process.env.OPENCLAW_CONFIG),
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, 'openclaw', 'openclaw.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = parseJsonc(raw);
        }
        parsed = resolveEnvVars(parsed);
        return { config: parsed, path: p };
      } catch (e) {
        console.warn(`⚠️  无法解析 OpenClaw 配置: ${p} (${e.message})`);
      }
    }
  }
  return null;
}

/** 从 OpenClaw 配置中提取 provider 信息 */
function extractProviders(ocConfig) {
  const providers = ocConfig?.models?.providers;
  if (!providers || typeof providers !== 'object') return [];

  const result = [];
  for (const [name, prov] of Object.entries(providers)) {
    if (!prov.apiKey) continue;
    result.push({
      name,
      baseUrl: prov.baseUrl || 'https://api.openai.com/v1',
      apiKey: prov.apiKey,
      models: (prov.models || []).map((m) => ({
        id: `${name}/${m.id}`,
        name: m.name || m.id,
        reasoning: m.reasoning || false,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });
  }
  return result;
}

/**
 * 加载配置：本地 config.json → OpenClaw 自动检测 → 校验
 * @param {string} configPath - config.json 的绝对路径
 * @returns {object} 最终配置
 */
export function loadConfig(configPath) {
  let localConfig = {};

  if (existsSync(configPath)) {
    try {
      localConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.warn(`⚠️  config.json 解析失败: ${e.message}`);
    }
  }

  // 如果本地没有 keys，尝试自动读取 OpenClaw 配置
  if (!localConfig.keys || localConfig.keys.length === 0) {
    const oc = readOpenClawConfig();
    if (oc) {
      console.log(`🔗 检测到 OpenClaw 配置: ${oc.path}`);
      const providers = extractProviders(oc.config);
      if (providers.length > 0) {
        console.log(`📦 发现 ${providers.length} 个 provider:`);
        for (const p of providers) {
          console.log(`   • ${p.name} → ${p.baseUrl} (${p.models.length} 模型)`);
        }

        localConfig.keys = providers.map((p) => ({
          id: p.name,
          key: p.apiKey,
          baseUrl: p.baseUrl,
        }));
        localConfig.baseUrl = providers[0].baseUrl;
        localConfig.models = providers.flatMap((p) => p.models);

        try {
          const out = {
            port: localConfig.port || 9200,
            baseUrl: localConfig.baseUrl,
            logLevel: localConfig.logLevel || 'info',
            healthCheckIntervalMs: localConfig.healthCheckIntervalMs || 300000,
            keyRetryDelayMs: localConfig.keyRetryDelayMs || 60000,
            keys: localConfig.keys.map((k) => ({ id: k.id, key: k.key, baseUrl: k.baseUrl })),
            models: localConfig.models,
          };
          writeFileSync(configPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
          console.log(`✅ 已生成 config.json → ${configPath}`);
        } catch (e) {
          console.warn(`⚠️  无法写入 config.json: ${e.message}`);
        }
      }
    } else {
      console.log('ℹ️  未检测到 OpenClaw 配置');
    }
  }

  if (!localConfig.keys || localConfig.keys.length === 0) {
    console.error('❌ 没有可用的 API Key。请：');
    console.error('   方式一：配置 OpenClaw（运行 openclaw onboard）');
    console.error('   方式二：编辑 config.json 手动添加 keys');
    process.exit(1);
  }

  return localConfig;
}
