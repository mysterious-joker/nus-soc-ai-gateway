# Local API

**Start with the [interactive local API reference](http://localhost:4000/reference)** while your gateway is running. It includes copyable cURL examples, required fields, sample responses and provider restrictions. Open **API reference** in the dashboard header if you use a custom port.

Download the [OpenAPI 3.1 contract](../public/openapi.json) for API clients and code-generation tools, or fetch `/openapi.json` from your running gateway. This is the client inference contract; dashboard management routes are intentionally outside its scope. The realtime operation documents the WebSocket handshake and example events, not a complete WebSocket event schema.

Base URL: `http://localhost:4000/v1`. These are your gateway's client-facing routes, not separately configured provider developer APIs. Compatibility covers the endpoints below, not the entire OpenAI API.

## Authentication and model selection

Create an app API key in Sources. Send it in the Bearer header. Query-string keys and cross-origin browser requests are unsupported.

```sh
export NUS_GATEWAY_KEY='YOUR_LOCAL_GATEWAY_KEY'
curl http://localhost:4000/v1/models \
  -H "Authorization: Bearer $NUS_GATEWAY_KEY"
```

The response is `{ "object": "list", "data": [...] }`. Entries include `id`, `owned_by`, `type`, `endpoints`, `discovery` and timestamped `verification`. Use the exact qualified ID, such as `chatgpt/<returned-id>`. Unqualified IDs work only when unique. `endpoints` lists successful checks for the current account; not every model supports every route.

## Text requests

Set `MODEL` to a real returned ID with the required endpoint:

```sh
export MODEL='PROVIDER/MODEL_FROM_YOUR_CATALOG'
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $NUS_GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Explain vector search briefly.\"}]}"

curl http://localhost:4000/v1/responses \
  -H "Authorization: Bearer $NUS_GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"Explain vector search briefly.\"}"
```

For streaming, add `"stream": true` and use `curl -N`. Chat Completions emits SSE data chunks ending in `[DONE]`; Responses emits named events. Check error events even when initial HTTP status is 200. Streamed usage depends on upstream support.

Gemini accepts text conversations with `model`, `messages` (chat) or `input`/`instructions` (Responses), `stream` and `stream_options`. It rejects tool calls, image/audio input, sampling controls and output-token limits. Each request starts a new isolated CLI conversation with supplied history serialized as text; this is not native role-message equivalence. Reported tokens include CLI context overhead.

## Routes

| Route                           | Request                                                                               | Connector        |
| ------------------------------- | ------------------------------------------------------------------------------------- | ---------------- |
| `POST /v1/chat/completions`     | JSON messages; optional SSE                                                           | All three        |
| `POST /v1/responses`            | JSON input; optional SSE                                                              | All three        |
| `POST /v1/embeddings`           | JSON `model`, `input`                                                                 | SoCLaaS          |
| `POST /v1/images/generations`   | JSON `model`, `prompt`, supported options                                             | ChatGPT bridge   |
| `POST /v1/images/edits`         | Multipart `model`, `prompt`, `image`, optional mask/options; bridge also accepts JSON | ChatGPT bridge   |
| `POST /v1/audio/transcriptions` | Multipart `model`, `file`, supported options                                          | SoCLaaS          |
| `POST /v1/audio/speech`         | JSON `model`, `input`, optional `voice`, `response_format`                            | ChatGPT realtime |
| `GET /v1/realtime?model=...`    | WebSocket upgrade with Bearer header                                                  | ChatGPT realtime |

A route is usable only when the selected model advertises it. Unknown capabilities are not silently routed to another provider.

### Uploads

```sh
curl http://localhost:4000/v1/audio/transcriptions \
  -H "Authorization: Bearer $NUS_GATEWAY_KEY" \
  -F "model=$MODEL" \
  -F 'file=@sample.wav'
```

Transcription supports JSON, verbose JSON, text, SRT and VTT where accepted upstream. Multipart bodies are limited to 26 MiB including overhead. Uploads stay in memory and are not saved to the usage database.

### Speech and realtime

Speech accepts 1–4,000 characters and returns WAV by default, or raw PCM with `response_format: "pcm"`. Both use mono 24 kHz, 16-bit audio. Voices are validated upstream; there is no fixed voice list.

Realtime requires a WebSocket client that can set an Authorization header; native browser WebSocket constructors cannot. JSON events are relayed, the model stays fixed, and client tools are not executed locally. Sessions last at most 15 minutes; frames/buffers are limited to 16 MiB. Revocation blocks new connections; existing sessions may remain until they close or time out. Stop the gateway to end all active sessions immediately.

## Errors and limits

Errors use `{ "error": { "message": "...", "type": "..." } }`. Gemini failures may include a stable `error.code`: `empty_model_response` (502), `upstream_failed` (502), or `upstream_timeout` (504). Blank or whitespace-only output never completes successfully. For streaming, a failure after headers is an error event (or `response.failed`), without a successful completion event; the usage ledger records the failure status. Raw CLI diagnostics are never returned. Common statuses: 400 invalid/unsupported input; 401 authentication; 403 authorization or unverified endpoint; 404 unknown model/route; 413 body limit; 429 quota/concurrency; 502 upstream failure; 503 unavailable/stale source; 504 timeout.

There are at most 16 active gateway requests/sessions and one Gemini inference request. Gemini allows 300 seconds for CLI generation and 315 seconds for its process wrapper; clients should allow at least 330 seconds. ChatGPT Chat Completions and Responses have a 600-second total deadline, including streamed output; configure callers for at least 630 seconds. A caller’s local timeout setting is not sent to the gateway and cannot extend this limit. Disconnecting cancels the upstream request. SoCLaaS HTTP requests retain a two-minute limit, images five minutes, and speech generation 60 seconds following initialization. JSON bodies are limited to 2 MiB and ordinary upstream responses to 64 MiB.

Dashboard `/api/*` routes require a dashboard cookie, plus CSRF for mutations. `/api/verify` is the privileged candidate-testing path. App keys cannot bypass verification.

The dashboard's **Verify all models** button starts a sequential batch with `POST /api/verification` (no body, HTTP 202). `GET /api/dashboard` includes `verification` progress and per-model endpoint results; `DELETE /api/verification` cancels it. These are dashboard administration routes, unavailable to app API keys. A second start returns 409 while a batch is active. The batch uses the same `/api/verify` authentication, quota guards, output validation and usage logging as an individual check. See [probe behavior and limits](verification.md#one-click-full-verification).
