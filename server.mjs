#!/usr/bin/env node
/**
 * KeyPool - OpenAI API Key Pool Proxy
 *
 * Zero-dependency Node.js proxy that multiplexes multiple OpenAI API keys
 * behind a single OpenAI-compatible endpoint.
 *
 * Features:
 *   - Round-robin key rotation with health awareness
 *   - Streaming (SSE) support
 *   - Automatic key disable on quota/auth errors
 *   - Periodic key health recovery
 *   - Per-key usage tracking
 *   - /v1/chat/completions, /v1/models, /v1/embeddings proxy
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────
const CONFIG_PATH = resolve(__dirname, "config.json");

/** 尝试从 JSONC / JS 对象字面量中提取配置（去掉注释、处理单引号等） */
function parseJsonLike(text) {
  // 去掉单行和多行注释
  let cleaned = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // 处理尾逗号
  cleaned = cleaned.replace(/,\s*([\]}])/g, "$1");
  // 处理无引号的 key
  cleaned = cleaned.replace(/(\s)(\w+)\s*:/g, '$1"$2":');
  // 处理单引号字符串
  cleaned = cleaned.replace(/'([^']*)'/g, '"$1"');
  return JSON.parse(cleaned);
}

/** 读取 OpenClaw 配置文件 */
function readOpenClawConfig() {
  const candidates = [
    // 标准路径
    join(homedir(), ".openclaw", "openclaw.json"),
    // 环境变量指定的路径
    process.env.OPENCLAW_CONFIG && resolve(process.env.OPENCLAW_CONFIG),
    // XDG 路径
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, "openclaw", "openclaw.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        let parsed;
        // 先尝试标准 JSON
        try {
          parsed = JSON.parse(raw);
        } catch {
          // 回退到 JSONC 解析
          parsed = parseJsonLike(raw);
        }
        // 解析环境变量引用
        parsed = resolveEnvVars(parsed);
        return { config: parsed, path: p };
      } catch (e) {
        console.warn(`⚠️  无法解析 OpenClaw 配置: ${p} (${e.message})`);
      }
    }
  }
  return null;
}

/** 解析环境变量引用 ${VAR_NAME} */
function resolveEnvVars(obj) {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

/** 从 OpenClaw 配置中提取 provider 信息 */
function extractProviders(ocConfig) {
  const providers = ocConfig?.models?.providers;
  if (!providers || typeof providers !== "object") return [];

  const result = [];
  for (const [name, prov] of Object.entries(providers)) {
    if (!prov.apiKey) continue;
    result.push({
      name,
      baseUrl: prov.baseUrl || "https://api.openai.com/v1",
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

function loadConfig() {
  // 1. 尝试读取本地 config.json
  let localConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      localConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch (e) {
      console.warn(`⚠️  config.json 解析失败: ${e.message}`);
    }
  }

  // 2. 尝试自动读取 OpenClaw 配置
  const oc = readOpenClawConfig();
  if (oc) {
    console.log(`🔗 检测到 OpenClaw 配置: ${oc.path}`);
    const providers = extractProviders(oc.config);
    if (providers.length > 0) {
      console.log(`📦 发现 ${providers.length} 个 provider:`);
      for (const p of providers) {
        console.log(`   • ${p.name} → ${p.baseUrl} (${p.models.length} 模型)`);
      }

      // 将 OpenClaw provider 合并为 key 池
      if (!localConfig.keys || localConfig.keys.length === 0) {
        localConfig.keys = [];
        for (const p of providers) {
          localConfig.keys.push({
            id: p.name,
            key: p.apiKey,
            _baseUrl: p.baseUrl,  // 每个 key 可以有独立的 baseUrl
          });
        }
        // 如果未指定 baseUrl，使用第一个 provider 的
        if (!localConfig.baseUrl) {
          localConfig.baseUrl = providers[0].baseUrl;
        }
        // 如果未指定 models，汇总所有 provider 的模型
        if (!localConfig.models) {
          localConfig.models = providers.flatMap((p) => p.models);
        }
      }
    }
  } else {
    console.log("ℹ️  未检测到 OpenClaw 配置，使用本地 config.json");
  }

  // 3. 验证最终配置
  if (!localConfig.keys || localConfig.keys.length === 0) {
    console.error("❌ 没有可用的 API Key。请：");
    console.error("   方式一：配置 OpenClaw（运行 openclaw onboard）");
    console.error("   方式二：编辑 config.json 手动添加 keys");
    process.exit(1);
  }

  return localConfig;
}

const config = loadConfig();
const PORT = config.port || 9200;
const BASE_URL = config.baseUrl || "https://api.openai.com";
const LOG_LEVEL = config.logLevel || "info";
const HEALTH_CHECK_INTERVAL = config.healthCheckIntervalMs || 5 * 60 * 1000; // 5 min
const KEY_RETRY_DELAY = config.keyRetryDelayMs || 60 * 1000; // 1 min
const AVAILABLE_MODELS = config.models || []; // 可用模型列表

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? 1;

function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= currentLogLevel) {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level] || "  ";
    console.log(`[${ts}] ${prefix}`, ...args);
  }
}

// ─── Key Pool ─────────────────────────────────────────────────────────
class KeyPool {
  constructor(keyConfigs) {
    this.keys = keyConfigs.map((kc, i) => ({
      id: kc.id || `key-${i + 1}`,
      key: kc.key,
      baseUrl: kc._baseUrl || null, // 每个 key 可以有独立的上游地址
      enabled: true,
      errorCount: 0,
      lastError: null,
      lastUsedAt: 0,
      stats: { requests: 0, tokens: 0, errors: 0 },
    }));
    this.index = 0;
    log("info", `Loaded ${this.keys.length} API key(s)`);
  }

  /** Pick next enabled key (round-robin). Returns null if all disabled. */
  pick() {
    const enabled = this.keys.filter((k) => k.enabled);
    if (enabled.length === 0) return null;

    // Round-robin among enabled keys
    this.index = this.index % enabled.length;
    const key = enabled[this.index];
    this.index = (this.index + 1) % enabled.length;
    key.lastUsedAt = Date.now();
    return key;
  }

  /** Mark a key as errored. Disable if too many consecutive errors. */
  markError(keyEntry, statusCode, body) {
    keyEntry.stats.errors++;
    keyEntry.errorCount++;
    keyEntry.lastError = { status: statusCode, body: body?.slice(0, 200), at: Date.now() };

    // Disable on quota (429) or auth (401/403) errors
    if ([401, 403, 429].includes(statusCode)) {
      keyEntry.enabled = false;
      log("warn", `Key ${keyEntry.id} disabled (${statusCode}). Will retry later.`);
    } else if (keyEntry.errorCount >= 3) {
      keyEntry.enabled = false;
      log("warn", `Key ${keyEntry.id} disabled after ${keyEntry.errorCount} consecutive errors.`);
    }
  }

  /** Record successful use. */
  markSuccess(keyEntry, tokens = 0) {
    keyEntry.stats.requests++;
    keyEntry.stats.tokens += tokens;
    keyEntry.errorCount = 0;
  }

  /** Periodically re-enable disabled keys. */
  recoverKeys() {
    for (const k of this.keys) {
      if (!k.enabled && k.lastError) {
        const elapsed = Date.now() - k.lastError.at;
        if (elapsed > KEY_RETRY_DELAY) {
          k.enabled = true;
          k.errorCount = 0;
          log("info", `Key ${k.id} re-enabled after ${Math.round(elapsed / 1000)}s`);
        }
      }
    }
  }

  getStats() {
    return this.keys.map((k) => ({
      id: k.id,
      enabled: k.enabled,
      lastUsed: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
      lastError: k.lastError,
      stats: { ...k.stats },
    }));
  }
}

const pool = new KeyPool(config.keys || []);

// Periodic health recovery
setInterval(() => pool.recoverKeys(), HEALTH_CHECK_INTERVAL);

// ─── Proxy Helpers ────────────────────────────────────────────────────
const defaultBase = new URL(BASE_URL);

function getTargetFor(keyEntry) {
  // 优先使用 key 自身的 baseUrl，否则用全局默认
  const base = keyEntry.baseUrl || BASE_URL;
  const parsed = new URL(base);
  return {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    isHttps: parsed.protocol === "https:",
  };
}

function proxyRequest(keyEntry, req, res) {
  const targetPath = req.url; // e.g. /v1/chat/completions
  const headers = { ...req.headers };
  const target = getTargetFor(keyEntry);

  // Replace auth header with the selected key
  delete headers["host"];
  headers["authorization"] = `Bearer ${keyEntry.key}`;

  const requester = target.isHttps ? httpsRequest : httpRequest;

  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: targetPath,
    method: req.method,
    headers,
  };

  const proxyReq = requester(opts, (proxyRes) => {
    const statusCode = proxyRes.statusCode;

    // Error handling
    if (statusCode >= 400) {
      let body = "";
      proxyRes.on("data", (c) => (body += c));
      proxyRes.on("end", () => {
        pool.markError(keyEntry, statusCode, body);

        // Try another key on auth/quota errors
        if ([401, 403, 429].includes(statusCode)) {
          const retryKey = pool.pick();
          if (retryKey && retryKey.id !== keyEntry.id) {
            log("info", `Retrying with key ${retryKey.id} after ${statusCode}`);
            return proxyRequest(retryKey, req, res);
          }
        }

        res.writeHead(statusCode, proxyRes.headers);
        res.end(body);
      });
      return;
    }

    // Success — stream response back
    const isStream =
      proxyRes.headers["content-type"]?.includes("text/event-stream");

    res.writeHead(statusCode, proxyRes.headers);

    if (isStream) {
      // Stream SSE — pipe chunks and track usage
      let buffer = "";
      let usage = null;

      proxyRes.on("data", (chunk) => {
        res.write(chunk);
        buffer += chunk.toString();

        // Parse SSE lines for usage data
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line
        for (const line of lines) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.usage) usage = data.usage;
            } catch {}
          }
        }
      });

      proxyRes.on("end", () => {
        res.end();
        const tokens = usage?.total_tokens || 0;
        pool.markSuccess(keyEntry, tokens);
        log("info", `✓ ${targetPath} [${keyEntry.id}] ${tokens} tokens (stream)`);
      });
    } else {
      // Non-streaming — buffer, parse usage, forward
      let body = "";
      proxyRes.on("data", (c) => (body += c));
      proxyRes.on("end", () => {
        res.end(body);
        let tokens = 0;
        try {
          const parsed = JSON.parse(body);
          tokens = parsed.usage?.total_tokens || 0;
        } catch {}
        pool.markSuccess(keyEntry, tokens);
        log("info", `✓ ${targetPath} [${keyEntry.id}] ${tokens} tokens`);
      });
    }
  });

  proxyReq.on("error", (err) => {
    pool.markError(keyEntry, 0, err.message);
    log("error", `Proxy error [${keyEntry.id}]:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: "Proxy error", type: "proxy_error" } }));
  });

  // Forward request body
  req.pipe(proxyReq);
}

// ─── Routes ───────────────────────────────────────────────────────────
function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS headers
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // ── Pool stats ──
  if (path === "/pool/stats" && req.method === "GET") {
    const stats = pool.getStats();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ keys: stats }, null, 2));
  }

  // ── Pool models ──
  if (path === "/pool/models" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: AVAILABLE_MODELS, sources: pool.keys.map((k) => ({ id: k.id, baseUrl: k.baseUrl || BASE_URL })) }, null, 2));
  }

  // ── Health ──
  if (path === "/health") {
    const enabled = pool.keys.filter((k) => k.enabled).length;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", enabledKeys: enabled, totalKeys: pool.keys.length }));
  }

  // ── /v1/models — 优先返回本地已知模型列表 ──
  if (path === "/v1/models" && req.method === "GET") {
    if (AVAILABLE_MODELS.length > 0) {
      const models = AVAILABLE_MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.id.split("/")[0] || "keypool",
        name: m.name,
        reasoning: m.reasoning || false,
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: models }, null, 2));
    }
    // 没有本地模型信息，走代理
  }

  // ── Proxy to upstream ──
  const proxyPaths = ["/v1/"];
  if (proxyPaths.some((p) => path.startsWith(p))) {
    const keyEntry = pool.pick();
    if (!keyEntry) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "No available API keys", type: "pool_exhausted" } }));
    }
    log("debug", `→ ${req.method} ${path} [${keyEntry.id}]`);
    return proxyRequest(keyEntry, req, res);
  }

  // ── Catch-all: usage info ──
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      {
        name: "KeyPool",
        version: "0.2.0",
        description: "OpenAI API Key Pool Proxy",
        endpoints: {
          "POST /v1/chat/completions": "Chat completions (OpenAI compatible)",
          "GET  /v1/models": "List models",
          "POST /v1/embeddings": "Embeddings",
          "GET  /pool/stats": "Key pool usage stats",
          "GET  /pool/models": "List all known models with details",
          "GET  /health": "Health check",
        },
        keys: pool.keys.length,
        models: AVAILABLE_MODELS.length,
        usage: `Set OPENAI_BASE_URL to http://127.0.0.1:${PORT}/v1`,
      },
      null,
      2
    )
  );
}

// ─── Server ───────────────────────────────────────────────────────────
const server = createServer(handleRequest);

server.listen(PORT, () => {
  log("info", `🚀 KeyPool running on http://127.0.0.1:${PORT}`);
  log("info", `   Proxying to ${BASE_URL}`);
  log("info", `   ${pool.keys.length} key(s) loaded`);
  if (AVAILABLE_MODELS.length > 0) {
    log("info", `   ${AVAILABLE_MODELS.length} model(s) available:`);
    for (const m of AVAILABLE_MODELS) {
      log("info", `     • ${m.id}${m.reasoning ? " 🧠" : ""}`);
    }
  }
  log("info", `   Set OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1 to use`);
  log("info", `   GET /pool/stats for usage, GET /health for status`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  log("info", "Shutting down...");
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
