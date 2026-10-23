const {
  PROVIDERS,
  discover,
  quota,
  requestJson,
  normalizeModel,
} = require("./providers");
const { HttpError, hash } = require("./security");
const { endpoints } = require("./capabilities");
function createCatalog({
  bridge,
  store,
  gemini,
  fetcher = fetch,
  discoverRealtime,
}) {
  let lastChecked = 0;
  let pending = null;
  let generation = 0;
  let sources = Object.fromEntries(
    Object.keys(PROVIDERS).map((p) => [
      p,
      {
        provider: p,
        name: PROVIDERS[p].name,
        domain: PROVIDERS[p].domain,
        status: "disconnected",
        models: [],
        accounts: [],
        quota: { windows: [], credits: null, status: "unavailable" },
        lastSyncAt: null,
        error: null,
      },
    ]),
  );
  function invalidate() {
    generation++;
    lastChecked = 0;
    for (const source of Object.values(sources)) source.models = [];
  }
  async function refresh(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - lastChecked < 60_000) return sources;
    const revision = generation;
    pending = (async () => {
      const next = {};
      await Promise.all(
        Object.keys(PROVIDERS).map(async (provider) => {
          const previous = sources[provider];
          const accounts = bridge
            .accounts()
            .filter((a) => a.provider === provider);
          const apiKey = provider === "soclaas" ? store.soclaasKey() : null;
          const source = {
            ...previous,
            accounts,
            models: [],
            error: null,
            quota: { windows: [], credits: null, status: "unavailable" },
            status: "disconnected",
          };
          next[provider] = source;
          if (provider === "gemini") {
            if (!gemini?.enabled()) return;
            try {
              const result = await gemini.discover();
              source.accounts = [result.account];
              source.scope = hash(JSON.stringify(result.account));
              source.models = result.models;
              source.status = "connected";
              source.lastSyncAt = new Date().toISOString();
              source.quota.note =
                "Remaining subscription quota is available in Antigravity CLI (/usage). This connector reports token usage for gateway requests.";
            } catch (error) {
              source.status = "error";
              source.error = error.status
                ? error.message
                : "Gemini CLI could not be reached. Sign in with agy and reconnect.";
              source.models = previous.models.map((m) => ({
                ...m,
                stale: true,
              }));
            }
            return;
          }
          const inputs =
            provider === "soclaas" ? (apiKey ? [{ apiKey }] : []) : accounts;
          if (!inputs.length) return;
          source.scope = hash(
            provider === "soclaas"
              ? apiKey
              : JSON.stringify(
                  accounts.map((a) => [a.id, a.email, a.subject]).sort(),
                ),
          );
          const models = new Map();
          const failures = [];
          let success = 0;
          for (const input of inputs) {
            try {
              const raw =
                provider === "soclaas" ? input : bridge.rawAccount(input);
              const result = await discover(provider, raw, fetcher);
              success++;
              for (const model of result.models)
                models.set(model.id, {
                  ...model,
                  discovery: "account-catalog",
                });
              try {
                const q = result.quota || (await quota(provider, raw, fetcher));
                source.quota.windows.push(
                  ...q.windows.map((w) => ({
                    ...w,
                    account: input.email || null,
                  })),
                );
                if (q.credits) {
                  source.quota.accounts ||= [];
                  source.quota.accounts.push({
                    email: input.email,
                    credits: q.credits,
                    plan: q.plan,
                  });
                }
                source.quota.note = q.note || null;
                source.quota.checkedAt = new Date().toISOString();
                if (q.windows.length || q.credits)
                  source.quota.status = "reported";
              } catch {
                source.quota.note =
                  "Quota could not be retrieved. Refresh later or check the provider portal.";
              }
            } catch (error) {
              failures.push(
                error.status
                  ? error.message
                  : "Provider could not be reached. Check your connection and refresh.",
              );
            }
          }
          source.lastSyncAt = success
            ? new Date().toISOString()
            : previous.lastSyncAt;
          source.status = success
            ? failures.length
              ? "partial"
              : "connected"
            : "error";
          source.error = failures.join(" ");
          if (provider === "chatgpt" && success)
            bridge.syncModels?.([...models.values()]);
          if (provider === "chatgpt" && success && bridge.port && bridge.key) {
            try {
              const registry = await requestJson(
                `http://127.0.0.1:${bridge.port}/v1/models`,
                { headers: { Authorization: `Bearer ${bridge.key}` } },
                fetcher,
              );
              if (!Array.isArray(registry.data))
                throw new Error("Invalid registry");
              for (const entry of registry.data) {
                if (!entry.id?.startsWith("chatgpt/")) continue;
                const model = normalizeModel(provider, {
                  ...entry,
                  id: entry.id.slice(8),
                });
                if (model && !models.has(model.id))
                  models.set(model.id, {
                    ...model,
                    discovery: "bridge-candidate",
                  });
              }
            } catch {
              source.error +=
                " Bridge candidate discovery failed; only the account catalog is shown.";
            }
          }
          // Keep last successful metadata visible on transient failure, but do not route through it.
          if (provider === "chatgpt" && success && discoverRealtime) {
            try {
              const service = await discoverRealtime();
              models.set(service.id, service);
            } catch {
              source.error +=
                " Realtime service discovery failed; refresh to retry.";
            }
          }
          source.models = success
            ? [...models.values()]
            : previous.models.map((m) => ({ ...m, stale: true }));
        }),
      );
      if (revision === generation) {
        sources = next;
        lastChecked = Date.now();
      }
      return sources;
    })().finally(() => {
      pending = null;
      if (revision !== generation)
        queueMicrotask(() => refresh(true).catch(() => {}));
    });
    return pending;
  }
  function list() {
    const checks = store.get("model_checks", {});
    return Object.values(sources).flatMap((s) =>
      s.models.map((m) => {
        const verification = checks[`${s.scope}:${m.id}`] || {
          status: "untested",
        };
        const supportedEndpoints = endpoints(m);
        const verifiedEndpoints = supportedEndpoints.filter(
          (e) => verification.endpoints?.[e]?.status === "passed",
        );
        const routable =
          !m.stale &&
          supportedEndpoints.length > 0 &&
          ["connected", "partial"].includes(s.status);
        return {
          ...m,
          discovery: m.discovery || "account-catalog",
          supportedEndpoints,
          endpoints: verifiedEndpoints,
          verification,
          routable,
          available: routable && verifiedEndpoints.length > 0,
          exclusionReason: !routable
            ? "Source disconnected, catalog stale, or connector unsupported."
            : !verifiedEndpoints.length
              ? "No endpoint has a successful request check for this account. Run catalog verification."
              : null,
        };
      }),
    );
  }
  function observeResult(
    model,
    endpoint,
    status,
    valid,
    { verification = false } = {},
  ) {
    const scope = sources[model.provider]?.scope;
    if (!scope) return;
    const checks = store.get("model_checks", {});
    const key = `${scope}:${model.id}`;
    const previous = checks[key] || {};
    // A runtime outage does not disprove access already verified for this account.
    // Explicit verification still records its result, including transient failures.
    if (
      !verification &&
      !valid &&
      (status === 408 || status === 429 || (status >= 500 && status < 600)) &&
      previous.endpoints?.[endpoint]?.status === "passed"
    )
      return;
    const result = {
      status: valid ? "passed" : "failed",
      httpStatus: status,
      checkedAt: new Date().toISOString(),
    };
    checks[key] = {
      ...result,
      endpoint,
      endpoints: { ...previous.endpoints, [endpoint]: result },
    };
    store.set(
      "model_checks",
      Object.fromEntries(Object.entries(checks).slice(-2000)),
    );
  }
  async function assertIncluded(model) {
    if (model.provider !== "chatgpt") return;
    const accounts = bridge.accounts().filter((a) => a.provider === "chatgpt");
    if (!accounts.length)
      throw new HttpError(403, "Connect ChatGPT Edu first.");
    // Check every selectable account: the bridge may choose any of them. Fail closed.
    for (const account of accounts) {
      let q;
      try {
        q = await quota("chatgpt", bridge.rawAccount(account), fetcher);
      } catch {
        throw new HttpError(
          503,
          "Included ChatGPT quota could not be verified. Request blocked to avoid credit fallback.",
        );
      }
      const windows = q.windows.filter((w) => w.label.startsWith("Codex ·"));
      if (!windows.length)
        throw new HttpError(
          503,
          "No included ChatGPT allowance was reported. Credit-based requests are disabled.",
        );
      if (windows.some((w) => w.remainingPercent <= 0))
        throw new HttpError(
          429,
          "Included ChatGPT allowance is exhausted. Wait for its reset; credit fallback is disabled.",
        );
    }
  }
  async function resolve(id, { allowUnverified = false, endpoint } = {}) {
    if (typeof id !== "string" || !id.trim())
      throw new HttpError(400, "Choose a model ID from GET /v1/models.");
    await refresh();
    const all = list();
    let model = all.find((m) => m.id === id);
    if (!model) {
      const matches = all.filter((m) => m.upstreamId === id);
      if (matches.length > 1)
        throw new HttpError(
          400,
          "This model ID exists at multiple sources. Use its provider-qualified ID from /v1/models.",
        );
      model = matches[0];
    }
    if (!model)
      throw new HttpError(
        404,
        "Model was not returned by a connected provider. Refresh the live catalog.",
      );
    if (!model.routable)
      throw new HttpError(
        503,
        "The model catalog is stale. Reconnect the source or refresh successfully before sending requests.",
      );
    if (
      !allowUnverified &&
      (!model.available || (endpoint && !model.endpoints.includes(endpoint)))
    )
      throw new HttpError(
        403,
        "This model endpoint has not passed verification for the connected account. Run catalog verification before using it.",
      );
    return model;
  }
  function observeHeaders(provider, headers) {
    const remaining = headers.get("x-ratelimit-remaining-tokens");
    const limit = headers.get("x-ratelimit-limit-tokens");
    if (
      remaining !== null &&
      Number.isFinite(Number(remaining)) &&
      Number(remaining) >= 0
    ) {
      const source = sources[provider];
      source.quota = {
        ...source.quota,
        tokenRateLimit: {
          remaining: Number(remaining),
          limit:
            limit !== null && Number.isFinite(Number(limit))
              ? Number(limit)
              : null,
          reset: headers.get("x-ratelimit-reset-tokens"),
        },
        checkedAt: new Date().toISOString(),
      };
    }
  }
  return {
    refresh,
    invalidate,
    list,
    resolve,
    observeHeaders,
    observeResult,
    assertIncluded,
    sources: () => Object.values(sources),
    get refreshing() {
      return Boolean(pending);
    },
  };
}
module.exports = { createCatalog };
