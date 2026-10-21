"use strict";
const $ = (id) => document.getElementById(id);
const TYPES = {
  llm: [
    "Large language models",
    "Text generation, reasoning, and conversational tasks.",
  ],
  embedding: [
    "Embedding models",
    "Vector representations for search and retrieval.",
  ],
  reranking: ["Reranking models", "Reorder results by relevance."],
  "speech-to-text": ["Speech recognition", "Audio transcription."],
  "text-to-speech": ["Speech synthesis", "Generate audio from text."],
  "realtime-audio": [
    "Realtime audio",
    "Streaming voice conversations and speech synthesis.",
  ],
  "image-generation": ["Image generation", "Generate images from prompts."],
  "video-generation": ["Video generation", "Generate video from prompts."],
  moderation: ["Content moderation", "Classify content for safety."],
  other: [
    "Other models",
    "The provider has not supplied a recognized task type.",
  ],
};
const NAMES = {
  chatgpt: "ChatGPT Edu",
  gemini: "Gemini Enterprise",
  soclaas: "SoCLaaS",
};
let csrf = null;
let dashboard = null;
let timer = null;
let toastTimer;
let loading = false;
let currentView = "sources";
let mediaUrls = [];
function clearMedia() {
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls = [];
  $("response-media").replaceChildren();
}
const fmt = (value) => new Intl.NumberFormat().format(value || 0);
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not synced";
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "onClick") node.addEventListener("click", value);
    else if (key === "onSubmit") node.addEventListener("submit", value);
    else if (key === "text") node.textContent = value;
    else if (value !== null && value !== undefined && value !== false)
      node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat())
    if (child !== null && child !== undefined)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  return node;
}
function notice(message) {
  $("notice").textContent = message || "";
  $("notice").hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3500);
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    notice(
      "Clipboard access is unavailable. Select and copy the text manually.",
    );
  }
}
async function api(url, { method = "GET", body, ...options } = {}) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
    ...options,
  });
  if (res.ok && res.headers.get("content-type")?.startsWith("audio/"))
    return { audioBlob: await res.blob() };
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      "Gateway returned an unreadable response. Reload and try again.",
    );
  }
  if (!res.ok) {
    if (
      res.status === 401 &&
      !url.includes("/session") &&
      !url.includes("/playground")
    )
      lockView();
    throw new Error(data.error?.message || `Request failed (${res.status}).`);
  }
  return data;
}
async function action(button, work, label = "Working…") {
  const old = button?.textContent;
  notice("");
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    await work();
  } catch (error) {
    notice(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = old;
    }
  }
}
function lockView() {
  csrf = null;
  dashboard = null;
  clearTimeout(timer);
  $("workspace").hidden = true;
  $("unlock").hidden = false;
  $("lock").hidden = true;
  $("new-key-value").value = "";
  $("new-key").hidden = true;
  $("source-list").replaceChildren();
  clearMedia();
  $("media-file").value = "";
  $("key-list").replaceChildren();
  $("response-output").textContent =
    "Choose a model and send your first request.";
}
async function unlock(token) {
  const data = await api("/api/session", { method: "POST", body: { token } });
  csrf = data.csrf;
  $("dashboard-token").value = "";
  await showWorkspace();
}
async function showWorkspace() {
  $("unlock").hidden = true;
  $("workspace").hidden = false;
  $("lock").hidden = false;
  await refresh();
}
function switchView(view) {
  currentView = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === view;
    button.setAttribute("aria-selected", selected);
    button.tabIndex = selected ? 0 : -1;
    $(button.dataset.view).hidden = !selected;
  }
  if (view === "playground") updateExample();
}
async function refresh() {
  if (loading || !csrf) return;
  loading = true;
  try {
    const data = await api(
      `/api/dashboard?timeframe=${encodeURIComponent($("timeframe").value)}`,
    );
    dashboard = data;
    render();
  } catch (error) {
    notice(error.message);
  } finally {
    loading = false;
    clearTimeout(timer);
    if (csrf)
      timer = setTimeout(
        refresh,
        dashboard?.refreshing ||
          !dashboard?.initialized ||
          Object.values(dashboard?.flows || {}).some((f) =>
            ["waiting", "verifying"].includes(f.status),
          )
          ? 2000
          : 30000,
      );
  }
}
function render() {
  $("gateway-status").textContent = !dashboard.initialized
    ? "Verifying saved accounts…"
    : "Gateway online";
  renderSetup();
  $("base-url").textContent = dashboard.baseUrl;
  $("model-count").textContent = dashboard.models.length;
  $("refresh").disabled = !dashboard.initialized || dashboard.refreshing;
  $("refresh").textContent = dashboard.refreshing
    ? "Refreshing…"
    : "Refresh sources";
  // Preserve in-progress API-key entry and keyboard focus during background updates.
  if (
    !$("source-list").querySelector("[data-dirty]") &&
    (!$("source-list").contains(document.activeElement) ||
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement?.tagName,
      ))
  )
    renderSources();
  renderModels();
  renderUsage();
  renderKeys();
  renderPlayground();
  if (dashboard.notices?.length && !$("notice").textContent)
    notice(dashboard.notices.join("\n"));
}
function renderSetup() {
  const connected = dashboard.sources.some(
    (source) => source.status === "connected" || source.status === "partial",
  );
  const verified = dashboard.models.some((model) => model.available);
  const keys = dashboard.keys.length > 0;
  $("setup-title").textContent =
    connected && verified && keys
      ? "Your gateway is ready"
      : "Set up your gateway";
  $("setup-steps").replaceChildren(
    ...[
      [
        "Connect a source",
        connected,
        () => $("source-list").scrollIntoView({ block: "start" }),
      ],
      ["Test a model", verified, () => openVerification()],
      [
        "Connect your app",
        keys,
        () => {
          $("app-keys").open = true;
          $("key-name").focus();
        },
      ],
    ].map(([label, complete, click]) =>
      el(
        "li",
        { class: complete ? "complete" : "" },
        button(label, click, { class: "quiet" }),
        el(
          "span",
          { class: "small muted" },
          complete ? "Complete" : "Next step",
        ),
      ),
    ),
  );
  const tools = dashboard.tools;
  if (!tools) return;
  const host = $("setup-tools");
  const wasOpen = host.querySelector("details")?.open;
  const details = el(
    "details",
    { class: "tool-details", open: wasOpen || !tools.bridge.installed },
    el(
      "summary",
      {},
      "Connection tools",
      el(
        "span",
        { class: "muted small" },
        tools.bridge.installed
          ? "ChatGPT tool detected"
          : "Prepare ChatGPT access",
      ),
    ),
  );
  const content = el(
    "div",
    { class: "details-body" },
    el(
      "p",
      {},
      tools.bridge.installed
        ? `ChatGPT: connection tool detected${tools.bridge.version ? ` (v${tools.bridge.version})` : ""}.`
        : "ChatGPT needs a small connection tool. The gateway downloads and verifies it for your computer.",
    ),
  );
  if (!tools.bridge.installed && tools.bridge.canInstall)
    content.append(
      button(
        tools.bridge.installing
          ? "Downloading and verifying…"
          : "Prepare ChatGPT connection",
        async () => {
          await api("/api/tools/bridge", { method: "POST" });
          await refresh();
          toast("Connection tool ready. Connect your ChatGPT account below.");
        },
        { disabled: tools.bridge.installing, class: "primary" },
      ),
    );
  if (!tools.bridge.canInstall && !tools.bridge.installed)
    content.append(
      el(
        "p",
        { class: "muted" },
        "Automatic setup is unavailable with this platform or CPA_BIN override. See the setup guide.",
      ),
    );
  if (tools.bridge.error)
    content.append(el("p", { class: "notice" }, tools.bridge.error));
  if (tools.bridge.installed && dashboard.bridge.error)
    content.append(el("p", { class: "notice" }, dashboard.bridge.error));
  content.append(
    el(
      "p",
      { class: "muted small" },
      tools.gemini.supported
        ? tools.gemini.installed
          ? "Gemini: Antigravity CLI detected. Sign in with your school subscription in agy, then connect the session below."
          : "Gemini: install the official Antigravity CLI and sign in with your school subscription, then return here."
        : "Gemini CLI integration is not yet enabled on Windows. ChatGPT and SoCLaaS remain available.",
    ),
    el(
      "div",
      { class: "button-row" },
      el(
        "a",
        {
          href: "https://antigravity.google/docs/getting-started?tab=cli",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "Gemini setup guide",
      ),
      button("Check again", refresh, { class: "quiet" }),
    ),
    el(
      "p",
      { class: "muted small" },
      "SoCLaaS needs only your API key. You can use it immediately.",
    ),
  );
  details.append(content);
  host.replaceChildren(details);
}
function openVerification() {
  $("verify-model").checked = true;
  renderPlayground();
  switchView("playground");
  $("playground-model").focus();
}
function button(text, fn, attrs = {}) {
  return el(
    "button",
    {
      type: "button",
      onClick: (event) => action(event.currentTarget, fn),
      ...attrs,
    },
    text,
  );
}
function renderSources() {
  const nodes = dashboard.sources.map((source) => {
    const name = el(
      "div",
      { class: "source-title" },
      el("h3", {}, source.name),
      el(
        "span",
        { class: `tag ${source.status}` },
        {
          disconnected: "Not connected",
          connected: "Connected",
          error: "Needs attention",
          partial: "Partial access",
        }[source.status] || source.status,
      ),
    );
    const identity = el(
      "div",
      {},
      name,
      el(
        "p",
        { class: "muted" },
        source.domain
          ? `@${source.domain} only`
          : "Connect with your SoCLaaS API key",
      ),
      el(
        "p",
        { class: "muted" },
        `${source.models.length} models · ${source.lastSyncAt ? `Synced ${date(source.lastSyncAt)}` : "Not synced yet"}`,
      ),
    );
    const local = dashboard.lifetime.byProvider.find(
      (p) => p.provider === source.provider,
    );
    identity.append(
      el(
        "p",
        { class: "muted" },
        `${fmt(local?.tokens)} recorded tokens · ${fmt(local?.requests)} gateway requests`,
      ),
    );
    const connection = el("div", { class: "source-connection" });
    if (source.provider === "soclaas") {
      const form = el(
        "form",
        {
          onSubmit: (event) => {
            event.preventDefault();
            const input = event.currentTarget.querySelector("input");
            const btn = event.currentTarget.querySelector("button");
            action(
              btn,
              async () => {
                await api("/api/providers/soclaas", {
                  method: "POST",
                  body: { apiKey: input.value },
                });
                input.value = "";
                document.activeElement?.blur();
                await refresh();
                toast("SoCLaaS key verified and connected");
              },
              "Verifying…",
            );
          },
        },
        el(
          "label",
          { for: "soclaas-key" },
          source.status === "disconnected"
            ? "SoCLaaS API key"
            : "Replace API key",
        ),
        el("input", {
          id: "soclaas-key",
          type: "password",
          required: true,
          autocomplete: "off",
          placeholder: "Paste your API key",
        }),
        el(
          "div",
          { class: "button-row" },
          el(
            "button",
            { type: "submit" },
            source.status === "disconnected" ? "Connect" : "Verify & replace",
          ),
        ),
      );
      if (source.status !== "disconnected")
        form.lastChild.append(
          button(
            "Disconnect",
            async () => {
              if (!confirm("Disconnect SoCLaaS from this gateway?")) return;
              await api("/api/providers/soclaas", { method: "DELETE" });
              await refresh();
            },
            { class: "quiet" },
          ),
        );
      connection.append(form);
    } else if (source.provider === "gemini") {
      for (const account of source.accounts)
        connection.append(el("p", {}, `${account.email} · ${account.project}`));
      connection.append(
        el(
          "p",
          { class: "muted small" },
          source.status === "connected"
            ? "Text chat through your school CLI subscription. Tool execution is disabled."
            : "Sign in with agy using your school subscription, then connect here. Text chat only; tool execution is disabled.",
        ),
      );
      const actions = el(
        "div",
        { class: "actions" },
        button(
          source.status === "disconnected"
            ? "Connect CLI session"
            : "Reconnect CLI session",
          async () => {
            await api("/api/providers/gemini/cli", { method: "POST" });
            await refresh();
            toast("Gemini CLI session connected");
          },
          {
            disabled:
              dashboard.tools &&
              (!dashboard.tools.gemini.installed ||
                !dashboard.tools.gemini.supported),
          },
        ),
      );
      if (source.status !== "disconnected")
        actions.append(
          button(
            "Disconnect",
            async () => {
              await api("/api/providers/gemini/cli", { method: "DELETE" });
              await refresh();
            },
            { class: "quiet" },
          ),
        );
      connection.append(actions);
    } else {
      for (const account of source.accounts)
        connection.append(
          el(
            "div",
            { class: "account" },
            el("span", {}, account.email),
            button(
              "Disconnect",
              async () => {
                if (!confirm(`Disconnect ${account.email}?`)) return;
                await api(
                  `/api/oauth/account?id=${encodeURIComponent(account.id)}`,
                  { method: "DELETE" },
                );
                await refresh();
              },
              { class: "quiet" },
            ),
          ),
        );
      const actions = el(
        "div",
        { class: "actions" },
        button(
          source.accounts.length ? "Add account" : "Connect account",
          () => startOAuth(source.provider, "browser"),
          { disabled: dashboard.tools && !dashboard.tools.bridge.installed },
        ),
      );
      if (source.provider === "chatgpt")
        actions.append(
          button(
            "Use device code",
            () => startOAuth(source.provider, "device"),
            {
              class: "quiet",
              disabled: dashboard.tools && !dashboard.tools.bridge.installed,
            },
          ),
        );
      connection.append(actions);
      if (source.provider === "chatgpt")
        connection.append(
          el(
            "p",
            { class: "muted small" },
            `Codex and realtime · ${source.models.filter((m) => m.discovery === "account-catalog").length} account entries (${source.models.filter((m) => m.providerHidden).length} hidden) · ${source.models.filter((m) => m.discovery === "bridge-candidate").length} bridge candidates · ${source.models.filter((m) => m.discovery === "service-session").length} discovered audio service.`,
          ),
        );
    }
    if (source.error)
      connection.append(el("p", { class: "danger" }, source.error));
    const remaining = el(
      "div",
      { class: "source-quota" },
      el("div", { class: "quota-title" }, "Remaining provider quota"),
    );
    const q = source.quota;
    if (q?.tokenRateLimit)
      remaining.append(
        el(
          "p",
          {},
          `${fmt(q.tokenRateLimit.remaining)} tokens left in the current rate-limit window`,
        ),
        el(
          "p",
          { class: "muted small" },
          `Rate limit, not total credit balance${q.tokenRateLimit.reset ? " · resets " + q.tokenRateLimit.reset : ""}`,
        ),
      );
    if (q?.status === "reported") {
      for (const account of q.accounts || [])
        remaining.append(
          el(
            "p",
            { class: "quota-value" },
            account.credits.unlimited
              ? "Credits: unlimited"
              : `${fmt(account.credits.balance)} credits`,
            account.email
              ? el("span", { class: "muted small" }, ` · ${account.email}`)
              : null,
          ),
        );
      const windows = q.windows || [];
      const quotaNode = (w) =>
        el(
          "div",
          { class: "quota-window" },
          el(
            "div",
            { class: "row" },
            el("span", {}, w.label),
            el("strong", {}, `${Math.round(w.remainingPercent)}% left`),
          ),
          el("progress", {
            value: w.remainingPercent,
            max: 100,
            "aria-label": `${w.label}: ${Math.round(w.remainingPercent)} percent remaining`,
          }),
          w.resetsAt ? el("small", {}, `Resets ${date(w.resetsAt)}`) : null,
          w.account && source.accounts.length > 1
            ? el("small", {}, w.account)
            : null,
        );
      windows.slice(0, 2).forEach((w) => remaining.append(quotaNode(w)));
      if (windows.length > 2)
        remaining.append(
          el(
            "details",
            { class: "quota-details" },
            el("summary", {}, `View all ${windows.length} quota windows`),
            windows.slice(2).map(quotaNode),
          ),
        );
      if (q.checkedAt)
        remaining.append(
          el(
            "p",
            { class: "muted small" },
            `Provider reported · ${date(q.checkedAt)}`,
          ),
        );
    } else {
      remaining.append(
        el(
          "div",
          { class: "quota-value" },
          source.status === "disconnected" ? "Connect to check" : "Unavailable",
        ),
        el(
          "p",
          { class: "muted" },
          source.status === "disconnected"
            ? "Quota appears when the provider exposes it."
            : q?.note || "This provider has not returned a remaining balance.",
        ),
      );
      if (source.provider === "soclaas")
        remaining.append(
          el(
            "p",
            {},
            el(
              "a",
              {
                href: "https://soclaas-portal.comp.nus.edu.sg/",
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "Open SoCLaaS portal",
            ),
          ),
        );
    }
    const node = el(
      "article",
      { class: "source" },
      identity,
      connection,
      remaining,
    );
    const flow = dashboard.flows[source.provider];
    if (flow && ["waiting", "verifying", "failed"].includes(flow.status)) {
      const line = el(
        "div",
        { class: "oauth-flow" },
        el(
          "p",
          {},
          flow.error ||
            (flow.status === "verifying"
              ? "Verifying your institutional identity…"
              : flow.authUrl
                ? "Complete sign-in, then return here."
                : "Preparing a secure sign-in link…"),
        ),
      );
      if (flow.status === "waiting") {
        if (flow.authUrl) {
          try {
            const url = new URL(flow.authUrl);
            if (
              url.protocol === "https:" &&
              ["auth.openai.com", "accounts.google.com"].includes(url.hostname)
            )
              line.append(
                el(
                  "a",
                  {
                    href: url.href,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  },
                  "Continue to sign in",
                ),
              );
          } catch {}
        }
        if (flow.deviceCode) line.append(el("code", {}, flow.deviceCode));
        line.append(
          button(
            "Cancel",
            async () => {
              await api("/api/oauth/cancel", {
                method: "POST",
                body: { provider: source.provider },
              });
              await refresh();
            },
            { class: "quiet" },
          ),
        );
      }
      node.append(line);
    }
    return node;
  });
  $("source-list").replaceChildren(...nodes);
}
async function startOAuth(provider, mode) {
  await api("/api/oauth/start", { method: "POST", body: { provider, mode } });
  await refresh();
  toast("Use the sign-in link below your source.");
}
function renderKeys() {
  $("key-list").replaceChildren(
    ...(dashboard.keys.length
      ? dashboard.keys.map((key) =>
          el(
            "div",
            { class: "key-row" },
            el(
              "div",
              {},
              el("span", {}, key.name),
              el("code", {}, `•••• ${key.hint || "existing key"}`),
            ),
            button(
              "Revoke",
              async () => {
                if (
                  !confirm(
                    `Revoke “${key.name}”? Apps using it will lose access.`,
                  )
                )
                  return;
                await api(`/api/keys?id=${encodeURIComponent(key.id)}`, {
                  method: "DELETE",
                });
                await refresh();
              },
              { class: "quiet danger" },
            ),
          ),
        )
      : [
          el(
            "p",
            { class: "empty" },
            "Create a key to connect your first app.",
          ),
        ]),
  );
}
function makeTable(headings, rows, cls = "") {
  return el(
    "table",
    { class: cls },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        headings.map((h) =>
          el("th", { scope: "col", class: h[1] || "" }, h[0]),
        ),
      ),
    ),
    el("tbody", {}, rows),
  );
}
function renderModels() {
  const search = $("model-search").value.toLowerCase();
  const provider = $("provider-filter").value;
  const type = $("type-filter").value;
  const models = dashboard.models.filter(
    (m) =>
      (m.available || $("show-excluded").checked) &&
      (provider === "all" || m.provider === provider) &&
      (type === "all" || m.type === type) &&
      `${m.name} ${m.id}`.toLowerCase().includes(search),
  );
  $("catalog-summary").textContent =
    `${dashboard.models.length} detected · ${dashboard.models.filter((m) => m.available).length} verified and usable · ${models.length} shown. Apps receive only endpoints with successful request checks. Counts include aliases and reasoning variants.`;
  $("coverage-list").replaceChildren(
    makeTable(
      [["Capability"], ["Discovered"], ["Latest request passed"]],
      Object.entries(TYPES)
        .filter(([kind]) => kind !== "other")
        .map(([kind, [title]]) => {
          const entries = dashboard.models.filter((m) => m.type === kind);
          return el(
            "tr",
            {},
            el("td", {}, title),
            el(
              "td",
              {},
              entries.length
                ? String(entries.length)
                : "None returned by these connectors",
            ),
            el(
              "td",
              {},
              String(
                entries.filter((m) => m.verification?.status === "passed")
                  .length,
              ),
            ),
          );
        }),
    ),
  );
  const groups = [];
  for (const [kind, [title, description]] of Object.entries(TYPES)) {
    const subset = models.filter((m) => m.type === kind);
    if (!subset.length) continue;
    const rows = subset.map((model) => {
      const stats = dashboard.lifetime.byModel.find(
        (u) => u.provider === model.provider && u.model === model.upstreamId,
      );
      const actions = el(
        "div",
        { class: "model-actions" },
        button("Copy ID", () => copy(model.id), {
          "aria-label": `Copy ${model.id}`,
        }),
      );
      if (
        model.routable &&
        [
          "llm",
          "embedding",
          "image-generation",
          "speech-to-text",
          "realtime-audio",
        ].includes(kind)
      )
        actions.append(
          button(
            model.available ? "Try" : "Verify",
            async () => {
              $("verify-model").checked = !model.available;
              renderPlayground();
              switchView("playground");
              $("playground-model").value = model.id;
              $("media-file").value = "";
              updateExample();
              $("prompt").focus();
            },
            {
              "aria-label": `${model.available ? "Try" : "Verify"} ${model.id}`,
            },
          ),
        );
      return el(
        "tr",
        {},
        el(
          "td",
          {},
          el("span", { class: "model-name" }, model.name),
          el("code", { class: "model-id" }, model.id),
          model.providerHidden
            ? el("span", { class: "tag" }, "Provider-hidden")
            : null,
          el(
            "span",
            {
              class: `tag ${model.verification?.status === "failed" ? "error" : ""}`,
            },
            model.verification?.status === "passed"
              ? "Request passed"
              : model.verification?.status === "failed"
                ? `Last request: HTTP ${model.verification.httpStatus}`
                : "Not tested",
          ),
          model.discovery === "bridge-candidate"
            ? el("span", { class: "tag" }, "Bridge candidate")
            : null,
          model.verification?.checkedAt
            ? el(
                "small",
                { class: "muted" },
                `${date(model.verification.checkedAt)} · ${model.verification.endpoint}`,
              )
            : null,
          model.exclusionReason
            ? el("small", { class: "muted" }, model.exclusionReason)
            : null,
          model.stale
            ? el("span", { class: "tag error" }, "Stale catalog")
            : null,
        ),
        el(
          "td",
          {},
          el("span", { class: `tag ${model.provider}` }, NAMES[model.provider]),
          model.multimodal ? el("span", { class: "tag" }, "Multimodal") : null,
        ),
        el(
          "td",
          { class: "num" },
          model.contextWindow ? fmt(model.contextWindow) : "—",
        ),
        el(
          "td",
          { class: "num" },
          stats?.requests
            ? `${fmt(stats.tokens)}${stats.reported < stats.requests ? " *" : ""}`
            : "—",
        ),
        el("td", {}, actions),
      );
    });
    groups.push(
      el(
        "section",
        { class: "model-group" },
        el(
          "h2",
          {},
          `${title} `,
          el("span", { class: "muted small" }, String(subset.length)),
        ),
        el("p", { class: "muted small" }, description),
        el(
          "div",
          { class: "table-scroll" },
          makeTable(
            [
              ["Model"],
              ["Source"],
              ["Context", "num"],
              ["Tokens used", "num"],
              ["Actions", "num"],
            ],
            rows,
            "model-table",
          ),
        ),
      ),
    );
  }
  $("model-list").replaceChildren(
    ...(groups.length
      ? groups
      : [
          el(
            "div",
            { class: "empty" },
            dashboard.models.length
              ? "No models match these filters."
              : dashboard.refreshing
                ? "Fetching the live model catalog…"
                : "Connect a source and refresh to discover its available models.",
          ),
        ]),
  );
}
function renderUsage() {
  const a = dashboard.analytics;
  const t = a.totals;
  $("usage-summary").replaceChildren(
    ...[
      [t.tokens, "Recorded tokens"],
      [t.input, "Input tokens"],
      [t.output, "Output tokens"],
      [t.requests, "Requests"],
    ].map(([value, label]) =>
      el("div", {}, el("strong", {}, fmt(value)), el("span", {}, label)),
    ),
  );
  $("usage-note").textContent =
    `${fmt(t.reported)} of ${fmt(t.requests)} requests have provider-reported token counts. Missing usage is not estimated.${t.legacy ? ` ${fmt(t.legacy)} older requests may contain estimates from the previous gateway.` : ""} This is local activity, not your remaining allowance.`;
  const rows = a.byModel.map((m) =>
    el(
      "tr",
      {},
      el(
        "td",
        {},
        el("span", { class: "model-name" }, m.model),
        el(
          "span",
          { class: `tag ${m.provider}` },
          NAMES[m.provider] || m.provider,
        ),
      ),
      ...["input", "output", "tokens", "requests"].map((k) =>
        el("td", { class: "num" }, fmt(m[k])),
      ),
      el("td", { class: "num" }, `${fmt(m.reported)}/${fmt(m.requests)}`),
    ),
  );
  $("usage-models").replaceChildren(
    rows.length
      ? makeTable(
          [
            ["Model / source"],
            ["Input", "num"],
            ["Output", "num"],
            ["Total", "num"],
            ["Requests", "num"],
            ["Usage reported", "num"],
          ],
          rows,
        )
      : el(
          "p",
          { class: "empty" },
          "No requests recorded yet. Try a model in the Playground.",
        ),
  );
  $("request-list").replaceChildren(
    a.recent.length
      ? makeTable(
          [
            ["Time"],
            ["Model"],
            ["Status", "num"],
            ["Tokens", "num"],
            ["Latency", "num"],
          ],
          a.recent.map((r) =>
            el(
              "tr",
              {},
              el("td", {}, date(r.timestamp)),
              el("td", {}, el("code", {}, `${r.provider}/${r.model}`)),
              el("td", { class: "num" }, String(r.status_code)),
              el(
                "td",
                { class: "num" },
                r.usage_source === "unavailable"
                  ? "Unavailable"
                  : `${fmt(r.total_tokens)}${r.usage_source === "legacy" ? " *" : ""}`,
              ),
              el("td", { class: "num" }, `${fmt(r.latency_ms)} ms`),
            ),
          ),
        )
      : el("p", { class: "empty" }, "No recent requests."),
  );
}
function renderPlayground() {
  const select = $("playground-model");
  const previous = select.value;
  const models = dashboard.models.filter(
    (m) =>
      (m.available || ($("verify-model").checked && m.routable)) &&
      [
        "llm",
        "embedding",
        "image-generation",
        "speech-to-text",
        "realtime-audio",
      ].includes(m.type),
  );
  select.replaceChildren(
    ...(models.length
      ? models.map((m) =>
          el("option", { value: m.id }, `${m.name} · ${NAMES[m.provider]}`),
        )
      : [
          el(
            "option",
            { value: "" },
            $("verify-model").checked
              ? "Connect a source to discover models"
              : "No verified models yet — enable verification above",
          ),
        ]),
  );
  if (models.some((m) => m.id === previous)) select.value = previous;
  $("send").disabled = !models.length || $("send").dataset.busy === "true";
  $("verification-note").hidden = !$("verify-model").checked;
  if ($("send").dataset.busy !== "true")
    $("send").textContent = $("verify-model").checked
      ? "Send & verify endpoint"
      : "Send request";
  updateExample();
}
function updateExample() {
  const model = dashboard?.models.find(
    (m) => m.id === $("playground-model").value,
  );
  const audio = model?.type === "speech-to-text",
    image = model?.type === "image-generation",
    speech = model?.type === "realtime-audio";
  const endpoint = speech
    ? "/audio/speech"
    : model?.type === "embedding"
      ? "/embeddings"
      : audio
        ? "/audio/transcriptions"
        : image
          ? $("media-file").files.length
            ? "/images/edits"
            : "/images/generations"
          : "/chat/completions";
  $("upload-field").hidden = !audio && !image;
  $("media-file").required = audio;
  $("media-file").accept = audio
    ? "audio/*,video/mp4,video/webm"
    : "image/png,image/jpeg,image/webp";
  $("upload-label").textContent = audio
    ? "Audio to transcribe"
    : "Reference image (optional, for editing)";
  $("prompt").required = !audio;
  $("prompt").placeholder = speech
    ? "Enter text to speak"
    : audio
      ? "Optional transcription context"
      : image
        ? "Describe the image to generate or the edit to make"
        : "Enter a prompt or text to embed";
  $("playground-endpoint").textContent = model
    ? `POST /v1${endpoint}`
    : "No compatible models available.";
  const body = speech
    ? { model: model.id, input: "Hello", response_format: "wav" }
    : model?.type === "embedding"
      ? { model: model.id, input: "Your text" }
      : image
        ? { model: model.id, prompt: "A blue circle on white", n: 1 }
        : {
            model: model?.id || "PROVIDER/MODEL_ID",
            messages: [{ role: "user", content: "Hello" }],
          };
  $("code-example").textContent =
    `curl ${dashboard?.baseUrl || "http://localhost:4000/v1"}${endpoint} \\\n  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''")}'`;
  if (audio || (image && $("media-file").files.length))
    $("code-example").textContent = [
      `curl ${dashboard.baseUrl}${endpoint}`,
      '-H "Authorization: Bearer YOUR_GATEWAY_KEY"',
      `-F 'model=${model.id}'`,
      `-F '${audio ? "file=@audio.wav" : "image=@reference.png"}'`,
      ...(image ? ["-F 'prompt=Make the circle green'"] : []),
    ].join(" \\\n  ");
}
$("unlock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(
    event.submitter,
    () => unlock($("dashboard-token").value),
    "Unlocking…",
  );
});
$("lock").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    await api("/api/session", { method: "DELETE" });
    lockView();
    $("dashboard-token").focus();
  }),
);
$("refresh").addEventListener("click", (event) =>
  action(
    event.currentTarget,
    async () => {
      await api("/api/refresh", { method: "POST" });
      await refresh();
      toast("Source refresh finished. Check each source for its status.");
    },
    "Refreshing…",
  ),
);
for (const tab of document.querySelectorAll("[data-view]")) {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-view]")];
    const i = tabs.indexOf(tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    switchView(tabs[next].dataset.view);
    tabs[next].focus();
  });
}
for (const [type, [label]] of Object.entries(TYPES))
  $("type-filter").append(el("option", { value: type }, label));
$("model-search").addEventListener("input", () => dashboard && renderModels());
for (const id of ["provider-filter", "type-filter", "show-excluded"])
  $(id).addEventListener("change", () => dashboard && renderModels());
$("timeframe").addEventListener("change", refresh);
$("copy-url").addEventListener("click", () => copy(dashboard.baseUrl));
$("copy-example").addEventListener("click", () =>
  copy($("code-example").textContent),
);
$("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(event.submitter, async () => {
    const key = await api("/api/keys", {
      method: "POST",
      body: { name: $("key-name").value },
    });
    $("new-key-value").value = key.token;
    $("new-key").hidden = false;
    $("key-name").value = "";
    await refresh();
    $("new-key-value").focus();
    $("new-key-value").select();
  });
});
$("copy-key").addEventListener("click", () => copy($("new-key-value").value));
$("hide-key").addEventListener("click", () => {
  $("new-key-value").value = "";
  $("new-key").hidden = true;
});
$("playground-model").addEventListener("change", () => {
  $("media-file").value = "";
  updateExample();
});
$("media-file").addEventListener("change", updateExample);
$("verify-model").addEventListener("change", renderPlayground);
$("test-discovered").addEventListener("click", openVerification);
$("playground-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const btn = event.submitter;
  action(
    btn,
    async () => {
      btn.dataset.busy = "true";
      const model = dashboard.models.find(
        (m) => m.id === $("playground-model").value,
      );
      if (!model) throw new Error("Choose an available model.");
      const text = $("prompt").value;
      const embedding = model.type === "embedding";
      const audio = model.type === "speech-to-text",
        image = model.type === "image-generation",
        speech = model.type === "realtime-audio";
      clearMedia();
      $("response-output").textContent = "Waiting for the provider…";
      $("response-meta").textContent = "";
      const started = performance.now();
      try {
        let endpoint = speech
          ? "/v1/audio/speech"
          : embedding
            ? "/v1/embeddings"
            : audio
              ? "/v1/audio/transcriptions"
              : image
                ? "/v1/images/generations"
                : "/v1/chat/completions";
        let body = speech
          ? { model: model.id, input: text, response_format: "wav" }
          : embedding
            ? { model: model.id, input: text }
            : image
              ? { model: model.id, prompt: text, n: 1 }
              : {
                  model: model.id,
                  messages: [{ role: "user", content: text }],
                };
        const file = $("media-file").files[0];
        if (audio || (image && file)) {
          if (!file) throw new Error("Choose an audio file.");
          if (file.size > 25 * 1024 * 1024)
            throw new Error("Choose a file smaller than 25 MiB.");
          if (image) endpoint = "/v1/images/edits";
          body = new FormData();
          body.set("model", model.id);
          body.set(audio ? "file" : "image", file);
          if (text) body.set("prompt", text);
        }
        const data = await api(
          `/api/${$("verify-model").checked ? "verify" : "playground"}?endpoint=${encodeURIComponent(endpoint)}`,
          {
            method: "POST",
            body,
          },
        );
        $("response-output").textContent = speech
          ? "Audio generated."
          : embedding
            ? JSON.stringify(
                {
                  model: data.model,
                  vectors: data.data?.map((x) => ({
                    index: x.index,
                    dimensions: x.embedding?.length,
                    preview: x.embedding?.slice(0, 12),
                  })),
                  usage: data.usage,
                },
                null,
                2,
              )
            : image
              ? `${data.data?.length || 0} image(s) returned.`
              : audio
                ? data.text
                : data.choices?.[0]?.message?.content ||
                  JSON.stringify(data, null, 2);
        if (speech && data.audioBlob) {
          const url = URL.createObjectURL(data.audioBlob);
          mediaUrls.push(url);
          $("response-media").append(
            el("audio", {
              src: url,
              controls: "",
              "aria-label": "Generated speech",
            }),
            el("a", { href: url, download: "speech.wav" }, "Download audio"),
          );
        }
        if (image)
          for (const [i, item] of (data.data || []).slice(0, 8).entries()) {
            if (item.b64_json) {
              const bytes = Uint8Array.from(atob(item.b64_json), (c) =>
                c.charCodeAt(0),
              );
              const mime =
                bytes[0] === 137 && bytes[1] === 80
                  ? "image/png"
                  : bytes[0] === 255 && bytes[1] === 216
                    ? "image/jpeg"
                    : bytes[0] === 82 && bytes[8] === 87
                      ? "image/webp"
                      : null;
              if (!mime) continue;
              const url = URL.createObjectURL(
                new Blob([bytes], { type: mime }),
              );
              mediaUrls.push(url);
              $("response-media").append(
                el("img", { src: url, alt: `Generated image ${i + 1}` }),
                el(
                  "a",
                  {
                    href: url,
                    download: `generated-${i + 1}.${mime.split("/")[1]}`,
                  },
                  "Download image",
                ),
              );
            } else if (item.url) {
              const url = new URL(item.url);
              if (url.protocol === "https:")
                $("response-media").append(
                  el(
                    "a",
                    {
                      href: url.href,
                      target: "_blank",
                      rel: "noopener noreferrer",
                    },
                    `Open generated image ${i + 1}`,
                  ),
                );
            }
          }
        $("response-meta").textContent =
          `${((performance.now() - started) / 1000).toFixed(1)} s · ${data.usage?.total_tokens != null ? fmt(data.usage.total_tokens) + " tokens" : speech ? "Token usage recorded in Usage" : "Usage not reported"}`;
      } catch (error) {
        $("response-output").textContent = error.message;
        throw error;
      } finally {
        delete btn.dataset.busy;
        await refresh();
      }
    },
    "Sending…",
  );
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && csrf) refresh();
});
async function resumeDashboard() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token");
  if (location.hash) history.replaceState(null, "", location.pathname);
  try {
    if (token) await unlock(token);
    else {
      const session = await api("/api/session");
      csrf = session.csrf;
      await showWorkspace();
    }
  } catch (error) {
    lockView();
    if (token) notice(error.message);
  }
}
// Desktop's Open dashboard command can navigate within the current document.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("token"))
    resumeDashboard();
});
resumeDashboard();
