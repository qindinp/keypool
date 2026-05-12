# KeyPool Models Endpoint Behavior

> Endpoint: `GET /v1/models`

## Purpose

`/v1/models` is used by SDKs and switchers to validate that the KeyPool Gateway is usable as an OpenAI-compatible base URL.

The endpoint aggregates model lists from all verified upstream instances.

## Source priority

For each verified upstream returned by `registry.getVerifiedUpstreams()`:

1. If the upstream has `proxyUrl`, `baseUrl`, or `localUrl`, Gateway requests:

   ```text
   GET <baseUrl>/v1/models
   ```

2. Otherwise, if the upstream has an active tunnel, Gateway sends a tunnel request:

   ```json
   {
     "method": "GET",
     "path": "/v1/models",
     "headers": { "content-type": "application/json" }
   }
   ```

3. Each returned item with an `id` is added to a Map keyed by model ID, which naturally de-duplicates models across accounts.

## Fallback behavior

If:

- at least one verified upstream exists, but
- none of the upstreams returns a usable `/v1/models` payload,

Gateway returns a small fallback Claude-style model list:

- `claude-sonnet-4-20250514`
- `claude-opus-4-20250514`
- `claude-3-7-sonnet-20250219`
- `claude-3-5-sonnet-20241022`

This fallback exists because some tunnel upstreams may support chat completions but not implement `/v1/models`; without a non-empty model list, clients such as SDKs or model switchers may incorrectly reject the base URL.

## Important diagnostics note

Fallback models do **not** prove that a real upstream model list was fetched.

When debugging model availability:

1. Check `/health` first.
2. Check logs for `collectModels [accountId]` or `collectModels [tunnel:accountId]` warnings.
3. Run a minimal `/v1/chat/completions` smoke test to verify the actual request path.

## Current risk

The fallback can hide the difference between:

- a healthy upstream that simply lacks `/v1/models`, and
- a broken upstream where `/v1/models` failed due to tunnel/proxy issues.

## Future improvement

Consider adding optional diagnostics metadata, for example:

```json
{
  "object": "list",
  "data": [...],
  "keypool": {
    "fallback": true,
    "verifiedUpstreams": 2,
    "queriedUpstreams": 2,
    "failedModelQueries": 2
  }
}
```

Do not add this metadata by default unless client compatibility has been verified; some OpenAI-compatible clients may reject extra top-level fields.
