This update fixes ChatGPT requests being cut off after 120 seconds.

- Chat Completions and Responses now allow up to **600 seconds**, including streamed output. Configure callers for at least **630 seconds**. A caller’s local timeout is not transmitted to the gateway and cannot extend this limit.
- HTTP transport and built-in verification clients now accommodate the longer deadline.
- Disconnecting still cancels the upstream request. Timeouts remain failures, including after partial streamed output; no automatic retry or paid fallback is added.
- Gemini, SoCLaaS and media deadlines are unchanged.

Install over your existing app after quitting it. Connections, app keys and usage history are retained. Apple Silicon Mac users should download **nus-soc-ai-gateway-2.3.2-mac-arm64.dmg**.

All existing platform limits remain: Gemini supports macOS/Linux, Mac apps are ad-hoc signed but not notarized, and Windows installers are unsigned. See the [API contract](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/api.md) and [setup guide](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/setup.md).
