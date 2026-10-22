This update fixes Gemini requests that returned HTTP 200 with an empty answer.

- Blank or whitespace-only CLI results now fail with `empty_model_response` (HTTP 502).
- Gemini generation has a 300-second CLI deadline and a 315-second process deadline. Configure clients for at least 330 seconds.
- Timeout and upstream failures have safe machine-readable codes. Raw CLI diagnostics are not returned or stored in the usage ledger.
- If streaming has already started, failures appear as an error event or `response.failed`, without a successful completion. Inspect stream events even when HTTP status is 200.
- The longer timeout does not guarantee that every workload finishes. Failed results remain failures and do not verify a model endpoint.

Install over your existing app after quitting it. Connections, app keys and usage history are retained. Apple Silicon Mac users should download **nus-soc-ai-gateway-2.3.1-mac-arm64.dmg**.

All existing platform limits remain: Gemini supports macOS/Linux, Mac apps are ad-hoc signed but not notarized, and Windows installers are unsigned. See the [API contract](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/api.md) and [setup guide](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/setup.md).
