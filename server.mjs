#!/usr/bin/env node
/**
 * KeyPool — 入口（向后兼容）
 *
 * 实际逻辑已拆分到 server/ 目录：
 *   - server/config.mjs           — 配置加载
 *   - server/key-pool.mjs         — Key 池管理
 *   - server/proxy.mjs            — HTTP 代理（有限重试 + 超时）
 *   - server/anthropic-adapter.mjs — Anthropic ↔ OpenAI 转换
 *   - server/tunnel.mjs           — SSH 隧道
 *   - server/index.mjs            — 主入口
 *
 * 此文件仅作为向后兼容入口，直接转发到 server/index.mjs
 */

import './server/index.mjs';
