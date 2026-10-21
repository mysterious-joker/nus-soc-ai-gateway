# Discovery, verification and quotas

## What the catalog means

Discovery and request verification are separate:

1. Fetch candidate IDs and capability metadata from connected sources.
2. Send an explicit, small test request for a selected model and endpoint.
3. Store the result with its timestamp and account/credential scope.
4. Expose successful endpoint combinations to app clients through `/v1/models`.

ChatGPT uses its authenticated Codex account catalog, the bridge model registry and the realtime service's `session.created` event. Registry-only entries are labeled **Bridge candidates**, not treated as entitlement proof. Gemini uses `agy models`, including reasoning variants. SoCLaaS uses its paginated `/v1/models` response and task metadata. The gateway has no static model-ID list.

Catalog refreshes coalesce, cache for one minute and run periodically every five minutes. Failed refreshes preserve visible metadata as stale and prevent routing. Checks belong to the connected account/credential; switching identity does not inherit another account's passes. Verification has no age-based expiry yet; timestamps and subsequent request failures determine its current evidence. An endpoint that fails a recorded request can require re-verification.

## One-click full verification

Open **Models → Verify all models**. No prompt, uploads or app key are needed. The gateway refreshes discovery and checks all detected models' supported endpoints, including models hidden by your current filters and previously verified models. It sends one request at a time, with no automatic retries. Unsupported or stale entries are reported as skipped.

The progress display reports each model and endpoint as passed, failed, skipped or cancelled. Successful checks immediately become available to apps. The batch continues if you change tabs or reload the dashboard; keep the gateway running. **Cancel verification**, locking the dashboard or quitting the app stops it. Cancelling an in-flight request cannot refund allowance already consumed. Source changes are blocked during a batch; cancel first.

Minimal probes:

| Capability                   | Request                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat and Responses           | `Reply OK.`; one request per endpoint. SoCLaaS requests cap output at 32 tokens. ChatGPT uses the lowest advertised reasoning level; its CLI bridge strips token caps. Gemini CLI rejects token caps and retains each discovered reasoning variant. |
| Embeddings                   | The text `OK`.                                                                                                                                                                                                                                      |
| Image generation and editing | One low-quality 1024 × 1024 image per endpoint, a short prompt and a bundled 32 × 32 edit input. This is a compatibility baseline, not a universal minimum size.                                                                                    |
| Speech recognition           | A bundled short, mono 16 kHz recording of synthetic “OK”.                                                                                                                                                                                           |
| Speech and realtime audio    | Speak `OK` once. Speech generates audio over the realtime WebSocket and verifies both routes; the results identify this shared check. It does not exercise microphone input or the public WebSocket relay.                                          |

These are real inference requests and consume the source's allowance. Actual token counts remain in **Usage**; some services do not report them. CLI-controlled reasoning, system prompts and media generation can exceed the visible prompt's token count. No separately billed API fallback is added.

HTTP 401, 402, 429 or 503 pauses the remaining checks for that source; other sources continue. Other failed requests are reported individually. A failed small probe can reflect a temporary error, unsupported probe options or too little output budget, rather than subscription exclusion. Try that endpoint in the Playground with appropriate input if needed. Skipped checks do not erase prior verification; a recorded failed request can disable that endpoint until a successful retest.

Batch progress is held in memory until the next run or restart; endpoint checks and usage remain in the local database. Generated test outputs are discarded. The batch starts only when requested, never at startup or in CI. Automated tests use synthetic providers.

## Verify selected access

Start the gateway and connect a source. Models shows untested entries by default. Use **Verify** beside a model to open it in the Playground, or copy its exact ID for a targeted command-line check:

```sh
node scripts/verify-models.js --live --provider chatgpt --model 'chatgpt/ID_FROM_DASHBOARD'
```

Replace the placeholder with a discovered ID. The primary endpoint is selected by capability. For a Responses endpoint:

```sh
node scripts/verify-models.js --live --provider gemini --endpoint /v1/responses --model 'gemini/ID_FROM_DASHBOARD'
```

The script uses a local dashboard session to test candidates through the CSRF-protected verification route. Normal app keys cannot bypass admission. It exits unsuccessfully on failed requests or no matching candidates. Skipped fixture-dependent capabilities are reported separately and remain unverified.

## Broader checks

These commands consume included allowance and can generate multiple images or requests. Review your source quotas first. They are never run at startup or by CI.

```sh
# All connected candidates' primary endpoints; provide synthetic audio for STT.
node scripts/verify-models.js --live --audio /absolute/path/to/sample.wav

# Additional endpoint combinations.
node scripts/verify-models.js --live --endpoint /v1/responses
node scripts/verify-models.js --live --endpoint /v1/images/edits --image output/verification-image.png
node scripts/verify-models.js --live --endpoint /v1/audio/speech

# Client-level smoke test across all three sources, after admission.
npm run verify:live

# Public WebSocket round trip, after speech/realtime admission.
node scripts/verify-realtime.js --live
```

Use `--provider chatgpt|gemini|soclaas` on `verify-models.js` to limit a run. The full smoke test expects all three sources; students with fewer sources should use the selected-provider checks. The model verifier and smoke test stop inference on a source after HTTP 429.

The smoke test creates a temporary app key, exercises public `/v1` routes, checks streaming, media, access controls and usage records, then revokes the key and checks rejection. Realtime verification generates a synthetic sentence, sends its audio back over the authenticated WebSocket and checks transcription.

## Independent catalog comparison

```sh
node scripts/audit-catalogs.js
```

The audit independently enumerates connected upstream catalogs and compares exact IDs against the client-facing catalog. Disconnected sources are labeled and skipped. Missing entries can mean newly discovered but unverified models, not necessarily a discovery bug. The audit opens sessions for discovery but does not request generated content. It creates and revokes a temporary app key. `GATEWAY_REPORT_DIR` can change its report directory.

Zero missing entries proves coverage of those returned catalogs. It does not prove all website features or hidden tool backends are accessible. Counts can change and include aliases/reasoning variants, so this repository does not publish a fixed universal model count.

## Reports and billing boundaries

Reports and generated fixtures are written under ignored `output/`. Reports include model IDs, metadata hashes, results, usage and timestamps, and may identify a school project. They are local diagnostic evidence, not safe-to-publish by default. Raw credentials are never intentionally written to reports. Use synthetic fixtures and review any attachment before sharing it.

ChatGPT quota checks use reported Codex windows before requests and realtime connection establishment. Unknown or exhausted allowance blocks access; bridge retry/project-switching fallback is disabled. This does not establish media-specific quotas or reserve credits for in-flight requests. Gemini uses the existing school CLI session; remaining subscription balance is viewed in CLI `/usage`. No verified SoCLaaS balance endpoint is integrated.

Rate-limit headers, account-wide quota and gateway-only token usage are displayed separately. Missing token usage stays unavailable; audio duration is not converted to tokens. Provider metering and institutional billing policies remain authoritative. The project does not promise that every account or future request incurs zero charges.
