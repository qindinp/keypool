# KeyPool Request Flows

> Generated: 2026-05-12 18:55 CST  
> Repo: `C:\Users\Administrator\.openclaw\workspace\keypool`

## 1. OpenAI non-stream flow

Endpoint:

```text
POST /v1/chat/completions
```

Flow:

```text
Client
  -> Gateway index.mjs
  -> proxy.mjs reads model
  -> Registry.chooseVerifiedUpstream(model)
  -> if upstream.tunnel exists:
       tunnel.sendProxyRequest(ws, req, { res })
       remote tunnel proxy calls MiMo API
       remote returns proxy_response or chunks
       Gateway writes response
     else / fallback:
       fetch(new URL(req.url, baseUrl))
       Gateway writes response text
  -> Registry.markProxySuccess or markProxyFailure
```

Current behavior:

- Tunnel is preferred over HTTP direct.
- If tunnel fails before response headers are sent, HTTP fallback may be used if URL exists.
- If response headers are already sent, fallback is impossible and response is ended.

Review risks:

- `markProxyFailure()` treats all failures as health failures.
- Upstream 4xx/5xx business responses through HTTP fetch are currently treated as successful transport after response is written.
- Tunnel `proxy_error` should be classified before marking health.

## 2. OpenAI stream flow

Endpoint:

```text
POST /v1/chat/completions
```

Request body has:

```json
{"stream": true}
```

Flow:

```text
Client
  -> Gateway proxy.mjs
  -> tunnel.sendProxyRequest(ws, req, { res })
  -> remote tunnel proxy streams MiMo SSE chunks
  -> remote sends proxy_response_chunk messages over WS
  -> tunnel.mjs decodes base64 chunks
  -> tunnel.mjs writes chunks to HTTP res
  -> remote sends proxy_response_end
  -> tunnel.mjs ends res
```

Review risks:

- `sendProxyRequest()` currently uses a flexible `res` option; mode should be explicit.
- If the same call provides both `res` and `onChunk`, double-write can occur unless forbidden by contract.
- Stream timeout is reset per chunk; long silent upstream waits still need a policy.

## 3. Anthropic non-stream flow

Endpoint:

```text
POST /v1/messages
```

Flow:

```text
Client
  -> Gateway index.mjs
  -> readBody(req)
  -> JSON parse Anthropic request
  -> anthropicToOpenAI(anthropicBody)
  -> Registry.chooseVerifiedUpstream(openaiReq.model)
  -> tunnel or HTTP call to /v1/chat/completions
  -> openAIToAnthropic(response)
  -> Gateway writes Anthropic-format JSON
```

Review risks:

- MiMo may return `reasoning_content` with `content=null`.
- Need explicit desired mapping:
  - reasoning -> Anthropic thinking block?
  - reasoning fallback -> text block?
- Non-stream adapter needs tests for text, reasoning, tools, and stop reasons.

## 4. Anthropic stream flow

Endpoint:

```text
POST /v1/messages
```

Request body has:

```json
{"stream": true}
```

Current uncommitted direction:

```text
Client
  -> Gateway index.mjs
  -> anthropicToOpenAI(... stream=true)
  -> tunnel.sendProxyRequest(ws, openai chat req, { onChunk })
  -> tunnel.mjs receives proxy_response_chunk
  -> tunnel.mjs calls onChunk(buf)
  -> index.mjs parses OpenAI SSE data lines
  -> openAIChunkToAnthropicEvents(oaiChunk, state)
  -> Gateway writes Anthropic SSE events
  -> proxy_response_end resolves
  -> Gateway writes final message_delta/message_stop and ends response
```

Expected Anthropic SSE events include:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`

Review risks:

- Current code should not pass `res` together with `onChunk`.
- `onChunk` exceptions are currently caught/logged in tunnel; caller may not know conversion failed.
- Final `lineBuf` flush must not duplicate chunks.
- Reasoning-only responses need correct thinking block lifecycle.
- If no content block started, final stop events need to remain valid for Anthropic SDK.

## 5. `/v1/models` flow

Endpoint:

```text
GET /v1/models
```

Flow:

```text
Client
  -> Gateway index.mjs collectModels(registry)
  -> registry.getVerifiedUpstreams()
  -> for each upstream:
       if baseUrl exists: fetch /v1/models
       else if tunnel exists: tunnel.sendProxyRequest(GET /v1/models)
  -> merge model IDs
  -> if no models but upstream exists: return fallback Claude model IDs
```

Current behavior:

- If actual model discovery returns empty but there are upstreams, fallback Claude IDs may be returned.

Review risk:

- Fallback can make clients believe Gateway is valid while upstream discovery is failing.

Proposed improvement:

- Include an internal diagnostic field in admin/health, not public OpenAI response.
- Log fallback use with account IDs and errors.
- Consider returning MiMo known fallback models instead of Claude names if target clients support it.

## 6. Tunnel registration flow

Flow:

```text
Remote keypool-tunnel starts
  -> opens WS to public Gateway /tunnel?accountId=...&runId=...
  -> sends { type: 'register', accountId, runId? }
  -> Gateway checks superseded run IDs
  -> closes previous tunnel for same account if different
  -> Registry.updateInstanceState(accountId, {
       tunnel,
       tunnelRunId,
       verified: true,
       healthOk: true,
       status: 'ACTIVE'
     })
  -> Gateway sends { type: 'registered' }
```

Review risks:

- Old remote process may keep reconnecting and be repeatedly rejected.
- `supersededRunIds` is in-memory only and capped at 20 per account.
- Need remote cleanup at deploy start to stop stale tunnel processes.

## 7. Deploy flow

Flow:

```text
Scheduler or Admin
  -> AccountWorker.create() or recover()
  -> createInstance() if needed
  -> deployCurrentInstance()
  -> Deployer connects to remote OpenClaw
  -> writes keypool-tunnel skill files
  -> starts tunnel proxy
  -> waits for prompt marker and/or tunnel registration
  -> AccountWorker marks ACTIVE or DEPLOYED_UNVERIFIED
```

Current success signals:

- prompt marker response from remote chat
- `result.verified`
- tunnel already connected in Registry before deploy returns

Proposed explicit success signals:

1. Remote create marker.
2. Remote start marker.
3. Gateway tunnel registration for the same account/runId.
4. Optional models/chat smoke.

## 8. Admin destroy current flow

```text
POST /admin/api/accounts/:id/destroy
  -> admin.mjs runAccountAction()
  -> worker.api.destroyInstance(cookie)
  -> worker.instance = null
  -> worker.state = 'DESTROYED'
  -> registry.status = 'DESTROYED'
  -> response ok
  -> next scheduler tick sees DESTROYED
  -> worker.create()
```

Risk:

- Human expected stop, system performs recreate.

Proposed safer flow:

```text
POST /admin/api/accounts/:id/stop
  -> worker.manualStop()
  -> destroy remote instance if present
  -> clear routeability and tunnel
  -> state MANUAL_STOPPED
  -> scheduler no-op
```

Then:

```text
POST /admin/api/accounts/:id/recover
  -> exit MANUAL_STOPPED
  -> create/deploy
```

## 9. Smoke flow

New script:

```text
scripts/smoke-keypool.ps1
```

Checks:

1. Port listener.
2. `GET /health`.
3. `GET /v1/models`.
4. `POST /v1/chat/completions` non-stream.
5. `POST /v1/messages` non-stream.

Future additions:

- OpenAI stream.
- Anthropic stream.
- Admin overview.
- Tunnel registration simulation or fixture test.

## 10. Immediate P0 request-flow tests

1. OpenAI non-stream returns any choice.
2. Anthropic non-stream handles reasoning-only MiMo response.
3. Anthropic stream emits valid final event sequence.
4. Tunnel callback mode never writes raw OpenAI SSE to the client.
5. Admin stop prevents routeability and scheduler recreation.
