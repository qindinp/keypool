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
import { spawn } from "node:child_process";

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

  // 2. 如果本地没有 keys，尝试自动读取 OpenClaw 配置并生成 config.json
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

        // 构建 config
        localConfig.keys = [];
        for (const p of providers) {
          localConfig.keys.push({
            id: p.name,
            key: p.apiKey,
            baseUrl: p.baseUrl,
          });
        }
        localConfig.baseUrl = providers[0].baseUrl;
        localConfig.models = providers.flatMap((p) => p.models);

        // 自动生成 config.json
        try {
          const out = {
            port: localConfig.port || 9200,
            baseUrl: localConfig.baseUrl,
            logLevel: localConfig.logLevel || "info",
            healthCheckIntervalMs: localConfig.healthCheckIntervalMs || 300000,
            keyRetryDelayMs: localConfig.keyRetryDelayMs || 60000,
            keys: localConfig.keys.map((k) => ({ id: k.id, key: k.key, baseUrl: k.baseUrl })),
            models: localConfig.models,
          };
          writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");
          console.log(`✅ 已生成 config.json → ${CONFIG_PATH}`);
        } catch (e) {
          console.warn(`⚠️  无法写入 config.json: ${e.message}`);
        }
      }
    } else {
      console.log("ℹ️  未检测到 OpenClaw 配置");
    }
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
const TUNNEL_ENABLED = config.tunnel !== false; // 默认开启
const TUNNEL_SERVICE = config.tunnelService || "localhost.run"; // serveo.net | localhost.run

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

// ─── Anthropic ↔ OpenAI 格式转换 ─────────────────────────────────────

/** Anthropic messages → OpenAI chat completions */
function anthropicToOpenAI(body) {
  const messages = [];

  // system 提取
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system.map((b) => b.text || "").join("\n");
      messages.push({ role: "system", content: text });
    }
  }

  // messages 转换
  for (const msg of body.messages || []) {
    const role = msg.role;
    let content;

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "image") {
          // 转成 OpenAI vision 格式
          parts.push({
            type: "image_url",
            image_url: {
              url: block.source?.type === "base64"
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source?.url || "",
            },
          });
        } else if (block.type === "tool_use") {
          // tool_use → assistant tool_calls
          // 需要特殊处理，先简化
          parts.push(`[tool_use: ${block.name}]`);
        } else if (block.type === "tool_result") {
          parts.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
        }
      }
      content = parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts;
    }

    messages.push({ role, content });
  }

  const result = {
    model: body.model || "gpt-4",
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences) result.stop = body.stop_sequences;

  return result;
}

/** OpenAI response → Anthropic message format */
function openAIToAnthropic(oaiResp, model) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: `msg_${oaiResp.id || randomId()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.reasoning_content) {
    content.push({ type: "thinking", thinking: choice.message.reasoning_content });
  }
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const stopReason = {
    stop: "end_turn",
    length: "max_tokens",
    "tool_calls": "tool_use",
    content_filter: "end_turn",
  }[choice.finish_reason] || "end_turn";

  return {
    id: `msg_${oaiResp.id || randomId()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
    },
  };
}

/** OpenAI SSE chunk → Anthropic SSE events */
function openAIChunkToAnthropicEvents(chunk, state) {
  const events = [];
  const choice = chunk.choices?.[0];

  if (!choice) return events;

  // 首个 chunk → message_start
  if (!state.started) {
    state.started = true;
    events.push({
      type: "message_start",
      message: {
        id: `msg_${chunk.id || randomId()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model || state.model,
        stop_reason: null,
        usage: { input_tokens: chunk.usage?.prompt_tokens || 0, output_tokens: 0 },
      },
    });
  }

  // reasoning_content → thinking delta
  if (choice.delta?.reasoning_content) {
    if (!state.thinkingStarted) {
      state.thinkingStarted = true;
      events.push({ type: "content_block_start", index: state.blockIndex, content_block: { type: "thinking", thinking: "" } });
    }
    events.push({ type: "content_block_delta", index: state.blockIndex, delta: { type: "thinking_delta", thinking: choice.delta.reasoning_content } });
  }

  // content → text delta
  if (choice.delta?.content) {
    if (!state.textStarted) {
      // 关闭 thinking block
      if (state.thinkingStarted && !state.thinkingClosed) {
        state.thinkingClosed = true;
        events.push({ type: "content_block_stop", index: state.blockIndex });
        state.blockIndex++;
      }
      state.textStarted = true;
      events.push({ type: "content_block_start", index: state.blockIndex, content_block: { type: "text", text: "" } });
    }
    events.push({ type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: choice.delta.content } });
  }

  // finish → stop
  if (choice.finish_reason) {
    // 关闭未关的 block
    if (state.textStarted && !state.textClosed) {
      state.textClosed = true;
      events.push({ type: "content_block_stop", index: state.blockIndex });
    } else if (state.thinkingStarted && !state.thinkingClosed) {
      state.thinkingClosed = true;
      events.push({ type: "content_block_stop", index: state.blockIndex });
    }

    const stopReason = {
      stop: "end_turn",
      length: "max_tokens",
      "tool_calls": "tool_use",
    }[choice.finish_reason] || "end_turn";

    events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens || 0 } });
    events.push({ type: "message_stop" });
  }

  return events;
}

function randomId() {
  return Math.random().toString(36).slice(2, 14);
}

/** 同步代理：Anthropic 请求 → OpenAI 上游 → Anthropic 响应 */
function proxyAnthropicSync(keyEntry, openaiReq, model, res) {
  const target = getTargetFor(keyEntry);
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${keyEntry.key}`,
  };
  const body = JSON.stringify(openaiReq);
  const requester = target.isHttps ? httpsRequest : httpRequest;

  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: "/v1/chat/completions",
    method: "POST",
    headers: { ...headers, "content-length": Buffer.byteLength(body) },
  };

  const proxyReq = requester(opts, (proxyRes) => {
    let respBody = "";
    proxyRes.on("data", (c) => (respBody += c));
    proxyRes.on("end", () => {
      if (proxyRes.statusCode >= 400) {
        pool.markError(keyEntry, proxyRes.statusCode, respBody);
        // 重试
        if ([401, 403, 429].includes(proxyRes.statusCode)) {
          const retryKey = pool.pick();
          if (retryKey && retryKey.id !== keyEntry.id) {
            log("info", `Anthropic retry with key ${retryKey.id}`);
            return proxyAnthropicSync(retryKey, openaiReq, model, res);
          }
        }
        res.writeHead(proxyRes.statusCode, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: respBody } }));
      }

      try {
        const oaiResp = JSON.parse(respBody);
        const anthropicResp = openAIToAnthropic(oaiResp, model);
        const tokens = oaiResp.usage?.total_tokens || 0;
        pool.markSuccess(keyEntry, tokens);
        log("info", `✓ /v1/messages [${keyEntry.id}] ${tokens} tokens (anthropic)`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(anthropicResp));
      } catch (e) {
        log("error", `Anthropic response conversion error: ${e.message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
      }
    });
  });

  proxyReq.on("error", (err) => {
    pool.markError(keyEntry, 0, err.message);
    log("error", `Anthropic proxy error [${keyEntry.id}]: ${err.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: err.message } }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

/** 流式代理：Anthropic SSE 请求 → OpenAI 流式上游 → Anthropic SSE 事件 */
function proxyAnthropicStream(keyEntry, openaiReq, model, res) {
  const target = getTargetFor(keyEntry);
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${keyEntry.key}`,
  };
  const body = JSON.stringify({ ...openaiReq, stream: true });
  const requester = target.isHttps ? httpsRequest : httpRequest;

  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: "/v1/chat/completions",
    method: "POST",
    headers: { ...headers, "content-length": Buffer.byteLength(body) },
  };

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  const state = { started: false, blockIndex: 0, thinkingStarted: false, thinkingClosed: false, textStarted: false, textClosed: false, model };

  const proxyReq = requester(opts, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      let errBody = "";
      proxyRes.on("data", (c) => (errBody += c));
      proxyRes.on("end", () => {
        pool.markError(keyEntry, proxyRes.statusCode, errBody);
        const event = { type: "error", error: { type: "api_error", message: errBody } };
        res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
      return;
    }

    let buffer = "";
    let usage = null;

    proxyRes.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const oaiChunk = JSON.parse(data);
          if (oaiChunk.usage) usage = oaiChunk.usage;

          const events = openAIChunkToAnthropicEvents(oaiChunk, state);
          for (const event of events) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        } catch {}
      }
    });

    proxyRes.on("end", () => {
      // 处理 buffer 中剩余数据
      if (buffer.startsWith("data: ") && buffer.slice(6).trim() !== "[DONE]") {
        try {
          const oaiChunk = JSON.parse(buffer.slice(6));
          if (oaiChunk.usage) usage = oaiChunk.usage;
          const events = openAIChunkToAnthropicEvents(oaiChunk, state);
          for (const event of events) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        } catch {}
      }

      // 确保 message_stop 被发送
      if (!state.textClosed && !state.thinkingClosed) {
        if (state.started) {
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        }
      }

      res.end();
      const tokens = usage?.total_tokens || 0;
      pool.markSuccess(keyEntry, tokens);
      log("info", `✓ /v1/messages [${keyEntry.id}] ${tokens} tokens (anthropic stream)`);
    });
  });

  proxyReq.on("error", (err) => {
    pool.markError(keyEntry, 0, err.message);
    log("error", `Anthropic stream proxy error [${keyEntry.id}]: ${err.message}`);
    const event = { type: "error", error: { type: "proxy_error", message: err.message } };
    res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });

  proxyReq.write(body);
  proxyReq.end();
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

  // ── Anthropic API: POST /v1/messages ──
  if (path === "/v1/messages" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const anthropicReq = JSON.parse(body);
        const keyEntry = pool.pick();
        if (!keyEntry) {
          res.writeHead(503, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "No available API keys" } }));
        }

        const openaiReq = anthropicToOpenAI(anthropicReq);
        const model = anthropicReq.model || "gpt-4";
        const isStream = !!anthropicReq.stream;

        log("info", `→ POST /v1/messages [${keyEntry.id}] Anthropic→OpenAI (model: ${model}, stream: ${isStream})`);

        if (isStream) {
          proxyAnthropicStream(keyEntry, openaiReq, model, res);
        } else {
          proxyAnthropicSync(keyEntry, openaiReq, model, res);
        }
      } catch (e) {
        log("error", `Anthropic request parse error: ${e.message}`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: e.message } }));
      }
    });
    return;
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
  let tunnelUrl = null;
  try {
    const urlFile = resolve(__dirname, ".tunnel-url");
    if (existsSync(urlFile)) tunnelUrl = readFileSync(urlFile, "utf-8").trim();
  } catch {}
  res.end(
    JSON.stringify(
      {
        name: "KeyPool",
        version: "0.3.0",
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
        tunnel: tunnelUrl || "disabled",
        usage: `Set OPENAI_BASE_URL to http://127.0.0.1:${PORT}/v1${tunnelUrl ? ` or ${tunnelUrl}/v1` : ""}`,
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

  // 启动 SSH 隧道
  startTunnel(PORT);
});

// ─── SSH Tunnel ───────────────────────────────────────────────────────
let tunnelProcess = null;

function startTunnel(port) {
  if (!TUNNEL_ENABLED) return;

  let cmd, args;
  if (TUNNEL_SERVICE === "serveo.net") {
    cmd = "ssh";
    args = ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=60", "-R", `80:localhost:${port}`, "serveo.net"];
  } else {
    // localhost.run — 不需要注册，支持自定义域名
    cmd = "ssh";
    args = ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=60", "-R", `80:localhost:${port}`, "nokey@localhost.run"];
  }

  log("info", `🌐 正在建立 SSH 隧道 (${TUNNEL_SERVICE})...`);

  tunnelProcess = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

  let urlFound = false;

  const handleOutput = (data) => {
    const text = data.toString();
    // 解析输出中的公网 URL
    const match = text.match(/(https?:\/\/[a-zA-Z0-9._-]+\.(?:lhr\.life|serveo\.net)[^\s]*)/);
    if (match && !urlFound) {
      urlFound = true;
      const publicUrl = match[1];
      console.log("");
      console.log("╔══════════════════════════════════════════════════════════╗");
      console.log("║  🌐 公网地址已就绪                                       ║");
      console.log("╠══════════════════════════════════════════════════════════╣");
      console.log(`║  ${publicUrl.padEnd(55)}║`);
      console.log("║                                                          ║");
      console.log(`║  API:  ${`${publicUrl}/v1/chat/completions`.padEnd(48)}║`);
      console.log(`║  统计:  ${`${publicUrl}/pool/stats`.padEnd(47)}║`);
      console.log(`║  健康:  ${`${publicUrl}/health`.padEnd(47)}║`);
      console.log("╚══════════════════════════════════════════════════════════╝");
      console.log("");

      // 写入文件方便其他服务读取
      try {
        writeFileSync(resolve(__dirname, ".tunnel-url"), publicUrl + "\n", "utf-8");
      } catch {}
    }
    // 其他有用的信息也打印
    if (!match && text.trim() && !text.includes("Warning")) {
      log("debug", `[tunnel] ${text.trim()}`);
    }
  };

  tunnelProcess.stdout.on("data", handleOutput);
  tunnelProcess.stderr.on("data", handleOutput);

  tunnelProcess.on("error", (err) => {
    log("warn", `SSH 隧道启动失败: ${err.message}`);
    log("info", "提示: 确保已安装 ssh 客户端，或在 config.json 中设置 \"tunnel\": false 关闭");
  });

  tunnelProcess.on("close", (code) => {
    if (code !== 0 && code !== null) {
      log("warn", `SSH 隧道断开 (code ${code})，30 秒后重连...`);
      setTimeout(() => startTunnel(port), 30000);
    }
  });
}

// Graceful shutdown
process.on("SIGINT", () => {
  log("info", "Shutting down...");
  if (tunnelProcess) tunnelProcess.kill();
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (tunnelProcess) tunnelProcess.kill();
  server.close();
  process.exit(0);
});
