const crypto = require("node:crypto");
const { HttpError, domainAllowed } = require("./security");
const PROVIDERS = {
  chatgpt: { name: "ChatGPT Edu", domain: "u.nus.edu", type: "codex" },
  gemini: {
    name: "Gemini Enterprise",
    domain: "comp.nus.edu.sg",
    type: "subscription-cli",
  },
  soclaas: { name: "SoCLaaS" },
};
const SOCLAAS_BASE = "https://soclaas-api.comp.nus.edu.sg/v1";
const CODEX_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
async function requestJson(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, {
    ...options,
    redirect: "error",
    signal: options.signal || AbortSignal.timeout(12_000),
  });
  if (!response.ok)
    throw new HttpError(
      502,
      `Provider returned HTTP ${response.status}. ${response.status === 401 ? "Reconnect this account." : response.status === 403 ? "Check account access and your NUS network connection." : "Try refreshing later."}`,
    );
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, "Provider returned an invalid JSON response.");
  }
}
function tokens(raw) {
  return raw.tokens && typeof raw.tokens === "object"
    ? raw.tokens
    : raw.token && typeof raw.token === "object"
      ? raw.token
      : raw;
}
function bearer(raw) {
  const t = tokens(raw);
  const headers = {
    Authorization: `Bearer ${t.access_token || raw.access_token}`,
    Accept: "application/json",
  };
  if (t.account_id || raw.account_id)
    headers["Chatgpt-Account-Id"] = t.account_id || raw.account_id;
  return headers;
}
function jwtParts(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    return {
      parts,
      header: JSON.parse(Buffer.from(parts[0], "base64url")),
      claims: JSON.parse(Buffer.from(parts[1], "base64url")),
    };
  } catch {
    throw new HttpError(
      403,
      "The provider did not return a valid identity token. Sign in again.",
    );
  }
}
function verifyIdToken(token, jwks, now = Date.now()) {
  const { parts, header, claims } = jwtParts(token);
  const jwk = jwks.keys?.find(
    (k) =>
      k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig"),
  );
  if (
    header.alg !== "RS256" ||
    !jwk ||
    !crypto.verify(
      "RSA-SHA256",
      Buffer.from(parts.slice(0, 2).join(".")),
      crypto.createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    )
  )
    throw new HttpError(403, "Identity token signature could not be verified.");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== "https://auth.openai.com" ||
    !audience.includes(CODEX_CLIENT) ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= now ||
    (claims.nbf && claims.nbf * 1000 > now + 60_000) ||
    claims.email_verified !== true ||
    !claims.sub
  )
    throw new HttpError(
      403,
      "Identity token is expired or not valid for this login. Sign in again.",
    );
  return claims;
}
async function verifyIdentity(provider, raw, fetcher = fetch) {
  const config = PROVIDERS[provider];
  if (!config?.domain || raw.type !== config.type)
    throw new HttpError(403, "Unexpected OAuth provider.");
  const t = tokens(raw);
  let email;
  let subject;
  if (!t.access_token)
    throw new HttpError(403, "Missing access token. Sign in again.");
  if (provider === "chatgpt") {
    // Refresh only before admission, while this credential is outside the running bridge.
    let parsed = jwtParts(t.id_token);
    if (parsed.claims.exp * 1000 <= Date.now() + 60_000 && t.refresh_token) {
      const refreshed = await requestJson(
        "https://auth.openai.com/oauth/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CODEX_CLIENT,
            refresh_token: t.refresh_token,
          }),
        },
        fetcher,
      );
      Object.assign(t, refreshed);
      raw.expired = new Date(
        Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      ).toISOString();
    }
    const jwks = await requestJson(
      "https://auth.openai.com/.well-known/jwks.json",
      {},
      fetcher,
    );
    const claims = verifyIdToken(t.id_token, jwks);
    if (claims.at_hash) {
      const actual = crypto
        .createHash("sha256")
        .update(t.access_token)
        .digest()
        .subarray(0, 16)
        .toString("base64url");
      if (actual !== claims.at_hash)
        throw new HttpError(
          403,
          "Access token does not match the verified identity.",
        );
    }
    const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (accountId && raw.account_id && accountId !== raw.account_id)
      throw new HttpError(
        403,
        "Account identity does not match. Sign in again.",
      );
    email = claims.email;
    subject = claims.sub;
  }
  if (!domainAllowed(email, config.domain))
    throw new HttpError(
      403,
      `${config.name} requires an @${config.domain} account. This account was not connected.`,
    );
  return {
    email: email.toLowerCase(),
    subject,
    verifiedAt: new Date().toISOString(),
  };
}
function classifyModel(raw) {
  const explicit = [
    raw.type,
    raw.model_type,
    raw.task,
    raw.task_type,
    raw.mode,
    raw.model_info?.mode,
    ...(Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((x) => typeof x === "string")
      : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const id = String(raw.id || raw.slug || raw.name || "").toLowerCase();
  const infer = (text) =>
    /embed/.test(text)
      ? "embedding"
      : /rerank/.test(text)
        ? "reranking"
        : /transcri|speech.to.text|whisper/.test(text)
          ? "speech-to-text"
          : /text.to.speech|tts|speech.synthesis/.test(text)
            ? "text-to-speech"
            : /image.generation|text.to.image|imagen|dall-e|diffusion|(?:^|-)image(?:-|$)/.test(
                  text,
                )
              ? "image-generation"
              : /video.generation|text.to.video|veo/.test(text)
                ? "video-generation"
                : /moderation/.test(text)
                  ? "moderation"
                  : /llm|chat|completion|generat(e|ion)content|language/.test(
                        text,
                      )
                    ? "llm"
                    : null;
  const methodType = infer(
    (raw.supportedGenerationMethods || []).join(" ").toLowerCase(),
  );
  const type =
    infer(explicit) ||
    (methodType !== "llm" ? methodType : null) ||
    infer(id) ||
    methodType ||
    (raw.slug || raw.supports_tools !== undefined ? "llm" : "other");
  const modalities = raw.input_modalities || raw.modalities?.input || [];
  return {
    type,
    classification:
      infer(explicit) || (!infer(id) && methodType) ? "provider" : "inferred",
    multimodal:
      Array.isArray(modalities) &&
      modalities.some((x) => ["image", "audio", "video"].includes(x)),
  };
}
function normalizeModel(provider, raw) {
  if (typeof raw === "string") raw = { id: raw };
  if (provider === "soclaas" && raw.soclaas && typeof raw.soclaas === "object")
    raw = { ...raw.soclaas, ...raw };
  const upstreamId = String(raw.id || raw.slug || raw.model || raw.name || "")
    .replace(/^models\//, "")
    .trim();
  if (
    !upstreamId ||
    upstreamId.length > 250 ||
    /[\x00-\x20\x7f]/.test(upstreamId)
  )
    return null;
  const context = Number(
    raw.context_window ||
      raw.context_length ||
      raw.max_context_length ||
      raw.max_model_len ||
      raw.inputTokenLimit ||
      raw.maxInputTokens ||
      raw.model_info?.max_input_tokens,
  );
  return {
    ...(provider === "chatgpt"
      ? { providerHidden: raw.visibility === "hide" }
      : {}),
    id: `${provider}/${upstreamId}`,
    upstreamId,
    provider,
    name: raw.display_name || raw.displayName || raw.title || upstreamId,
    contextWindow: Number.isFinite(context) && context > 0 ? context : null,
    inputModalities: Array.isArray(raw.input_modalities)
      ? raw.input_modalities.filter((x) => typeof x === "string")
      : [],
    reasoningLevels: Array.isArray(raw.supported_reasoning_levels)
      ? raw.supported_reasoning_levels
          .map((x) => x.effort)
          .filter((x) => typeof x === "string")
      : [],
    ...classifyModel({ ...raw, id: upstreamId }),
  };
}
function parseCodexQuota(data) {
  const windows = [];
  function add(rate, label = "Codex") {
    for (const key of ["primary_window", "secondary_window"]) {
      const w = rate?.[key];
      if (
        !w ||
        typeof w.used_percent !== "number" ||
        !Number.isFinite(w.used_percent)
      )
        continue;
      const seconds = Number(w.limit_window_seconds);
      const duration =
        seconds >= 86400
          ? `${Math.round(seconds / 86400)}-day`
          : seconds > 0
            ? `${Math.round(seconds / 3600)}-hour`
            : key === "primary_window"
              ? "Primary"
              : "Secondary";
      windows.push({
        label: `${label} · ${duration}`,
        remainingPercent: Math.max(0, Math.min(100, 100 - w.used_percent)),
        resetsAt: Number.isFinite(w.reset_at)
          ? new Date(w.reset_at * 1000).toISOString()
          : null,
      });
    }
  }
  add(data.rate_limit);
  for (const r of data.additional_rate_limits || [])
    add(r.rate_limit, r.limit_name || "Additional limit");
  const credits = data.credits;
  return {
    windows,
    credits:
      credits?.unlimited === true
        ? { unlimited: true }
        : credits?.balance != null && Number.isFinite(Number(credits.balance))
          ? { balance: Number(credits.balance) }
          : null,
    plan: data.plan_type || null,
  };
}
async function discover(provider, raw, fetcher = fetch) {
  if (provider === "chatgpt") {
    const data = await requestJson(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1",
      { headers: { ...bearer(raw), "User-Agent": "codex-cli/0.162.1" } },
      fetcher,
    );
    if (!Array.isArray(data.models))
      throw new HttpError(502, "Unrecognized ChatGPT model catalog response.");
    return {
      models: data.models
        .map((m) => normalizeModel(provider, { ...m, type: "llm" }))
        .filter(Boolean),
    };
  }
  if (provider !== "soclaas") throw new HttpError(400, "Unsupported provider.");
  const models = [];
  let after = null;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await requestJson(
      `${SOCLAAS_BASE}/models${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      { headers: { Authorization: `Bearer ${raw.apiKey}` } },
      fetcher,
    );
    if (!Array.isArray(data.data))
      throw new HttpError(502, "Unrecognized SoCLaaS model catalog response.");
    models.push(
      ...data.data.map((m) => normalizeModel(provider, m)).filter(Boolean),
    );
    if (!data.has_more) return { models };
    after = data.last_id || data.data.at(-1)?.id;
    if (!after || seen.has(after))
      throw new HttpError(
        502,
        "SoCLaaS model pagination could not be completed.",
      );
    seen.add(after);
  }
  throw new HttpError(502, "SoCLaaS returned too many catalog pages.");
}
async function quota(provider, raw, fetcher = fetch) {
  if (provider === "chatgpt")
    return parseCodexQuota(
      await requestJson(
        "https://chatgpt.com/backend-api/wham/usage",
        { headers: bearer(raw) },
        fetcher,
      ),
    );
  // No documented SoCLaaS balance endpoint is available. Never infer credits from tokens.
  return {
    windows: [],
    credits: null,
    note: "The provider does not expose a verified balance endpoint to this gateway.",
  };
}
module.exports = {
  PROVIDERS,
  SOCLAAS_BASE,
  requestJson,
  tokens,
  bearer,
  verifyIdToken,
  verifyIdentity,
  classifyModel,
  normalizeModel,
  parseCodexQuota,
  discover,
  quota,
};
