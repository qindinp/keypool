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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────
const CONFIG_PATH = resolve(__dirname, "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("❌ config.json not found. Copy config.example.json and add your keys.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

const config = loadConfig();
const PORT = config.port || 9200;
const BASE_URL = config.baseUrl || "https://api.openai.com";
const LOG_LEVEL = config.logLevel || "info";
const HEALTH_CHECK_INTERVAL = config.healthCheckIntervalMs || 5 * 60 * 1000; // 5 min
const KEY_RETRY_DELAY = config.keyRetryDelayMs || 60 * 1000; // 1 min

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
const parsedBase = new URL(BASE_URL);
const isHttps = parsedBase.protocol === "https:";
const requester = isHttps ? httpsRequest : httpRequest;

function proxyRequest(keyEntry, req, res) {
  const targetPath = req.url; // e.g. /v1/chat/completions
  const headers = { ...req.headers };

  // Replace auth header with the selected key
  delete headers["host"];
  headers["authorization"] = `Bearer ${keyEntry.key}`;

  const opts = {
    hostname: parsedBase.hostname,
    port: parsedBase.port || (isHttps ? 443 : 80),
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

  // ── Health ──
  if (path === "/health") {
    const enabled = pool.keys.filter((k) => k.enabled).length;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", enabledKeys: enabled, totalKeys: pool.keys.length }));
  }

  // ── Proxy to OpenAI ──
  const proxyPaths = ["/v1/", "/v1/models", "/v1/chat/completions", "/v1/embeddings", "/v1/audio"];
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
        version: "0.1.0",
        description: "OpenAI API Key Pool Proxy",
        endpoints: {
          "POST /v1/chat/completions": "Chat completions (OpenAI compatible)",
          "GET  /v1/models": "List models",
          "POST /v1/embeddings": "Embeddings",
          "GET  /pool/stats": "Key pool usage stats",
          "GET  /health": "Health check",
        },
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
