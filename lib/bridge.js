const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  privateDir,
  privateWrite,
  secretFile,
  hash,
  HttpError,
  random,
} = require("./security");
const { PROVIDERS, verifyIdentity } = require("./providers");
function createBridge({
  dataDir,
  port,
  store,
  binary,
  verify = verifyIdentity,
  onChange = () => {},
}) {
  const activeDir = path.join(dataDir, "verified-auths");
  const stagingDir = path.join(dataDir, "oauth-staging");
  const quarantineDir = path.join(dataDir, "quarantine");
  [activeDir, stagingDir, quarantineDir].forEach(privateDir);
  const key = secretFile(path.join(dataDir, "bridge-token"));
  const managementKey = secretFile(
    path.join(dataDir, "bridge-management-token"),
  );
  const configPath = path.join(dataDir, "cliproxyapi.yaml");
  let catalogPath = store?.get?.("bridge_catalog_path", "") || "";
  if (
    !catalogPath.startsWith(path.resolve(dataDir) + path.sep) ||
    !fs.existsSync(catalogPath)
  )
    catalogPath = "";
  let proc = null;
  let stopping = false;
  let restart = null;
  let attempts = 0;
  const flows = {};
  const notices = [];
  const status = { running: false, error: null };
  const credentials = new Map();
  function writeConfig(file, authDir) {
    // JSON is valid YAML; structured serialization prevents config injection.
    privateWrite(
      file,
      JSON.stringify(
        {
          "config-version": 8,
          ...(catalogPath ? { models: { catalog: catalogPath } } : {}),
          server: { host: "127.0.0.1", port },
          management: {
            "allow-remote": false,
            "secret-key": managementKey,
            "disable-control-panel": true,
          },
          access: { "api-keys": [key] },
          "quota-exceeded": {
            "switch-project": false,
            "switch-preview-model": false,
          },
          multimedia: { "disable-image-generation": "passthrough" },
          routing: {
            strategy: "round-robin",
            "force-model-prefix": true,
            retry: { "request-retry": 0 },
          },
          oauth: {
            "auth-dir": authDir,
            providers: {
              codex: { "signin-with-chatgpt-identifier": "NUS SoC AI Gateway" },
            },
          },
          observability: {
            logs: {
              debug: false,
              "logging-to-file": false,
              "request-log": false,
              "max-error-logs": 0,
            },
            usage: { "usage-statistics-enabled": true },
          },
        },
        null,
        2,
      ),
    );
  }
  function accounts() {
    return [...credentials.values()].map(({ id, provider, identity }) => ({
      id,
      provider,
      ...identity,
    }));
  }
  function rawAccount(account) {
    const file = path.join(activeDir, account.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      raw.type !== PROVIDERS[account.provider].type ||
      raw.prefix !== account.provider ||
      raw.disabled
    )
      throw new HttpError(403, "Account is disabled. Reconnect it.");
    return raw;
  }
  async function admit(
    file,
    provider,
    id = `${provider}-${random().slice(0, 16)}.json`,
  ) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const identity = await verify(provider, raw);
    raw.prefix = provider;
    raw.disabled = false;
    raw.email = identity.email;
    const dest = path.join(activeDir, id);
    privateWrite(dest, JSON.stringify(raw, null, 2));
    credentials.set(id, { id, provider, identity });
    return { id, provider, ...identity };
  }
  async function initialize() {
    // Validate before starting the bridge. Unverified files never enter its auth directory.
    for (const dir of [activeDir, path.join(dataDir, "auths")]) {
      if (!fs.existsSync(dir)) continue;
      fs.chmodSync(dir, 0o700);
      for (const name of fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".json"))) {
        const file = path.join(dir, name);
        if (!fs.lstatSync(file).isFile()) continue;
        fs.chmodSync(file, 0o600);
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf8"));
          const provider = Object.keys(PROVIDERS).find(
            (p) => PROVIDERS[p].type && PROVIDERS[p].type === raw.type,
          );
          if (!provider)
            throw new HttpError(403, "Unsupported OAuth credential.");
          await admit(file, provider, dir === activeDir ? name : undefined);
          if (dir !== activeDir) fs.renameSync(file, file + ".migrated");
        } catch (error) {
          fs.renameSync(
            file,
            path.join(quarantineDir, `${Date.now()}-${name}.disabled`),
          );
          notices.push(
            error.status
              ? error.message
              : "An existing credential could not be verified. Reconnect the account.",
          );
        }
      }
    }
    writeConfig(configPath, activeDir);
  }
  function start() {
    if (proc || stopping) return;
    const executable = typeof binary === "function" ? binary() : binary;
    if (!executable) {
      status.error =
        "Prepare the ChatGPT connection tool in Sources to get started.";
      return;
    }
    clearTimeout(restart);
    writeConfig(configPath, activeDir);
    const child = spawn(executable, ["-config", configPath], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, MANAGEMENT_PASSWORD: "" },
    });
    proc = child;
    child.once("spawn", () => {
      status.running = true;
      status.error = null;
    });
    child.once("error", () => {
      status.running = false;
      status.error =
        "CLIProxyAPI could not start. Check that cliproxyapi is installed.";
    });
    child.once("exit", () => {
      status.running = false;
    });
    child.once("close", () => {
      if (proc === child) proc = null;
      status.running = false;
      if (!stopping && ++attempts <= 3) restart = setTimeout(start, 3000);
      else if (!stopping)
        status.error =
          "CLIProxyAPI stopped. Check its installation and that the bridge port is free, then restart the gateway.";
    });
  }
  function publicFlow(flow) {
    if (!flow) return null;
    return {
      provider: flow.provider,
      status: flow.status,
      authUrl: flow.authUrl,
      deviceCode: flow.deviceCode,
      error: flow.error,
      account: flow.account,
    };
  }
  async function startLogin(provider, mode) {
    const executable = typeof binary === "function" ? binary() : binary;
    if (!executable)
      throw new HttpError(
        503,
        "Prepare the ChatGPT connection tool in Sources first.",
      );
    if (provider !== "chatgpt") throw new HttpError(400, "Choose ChatGPT Edu.");
    if (!["browser", "device"].includes(mode))
      throw new HttpError(400, "Unsupported login mode.");
    if (
      Object.values(flows).some((f) =>
        ["waiting", "verifying"].includes(f.status),
      )
    )
      throw new HttpError(409, "Finish or cancel the current sign-in first.");
    const dir = fs.mkdtempSync(path.join(stagingDir, "login-"));
    fs.chmodSync(dir, 0o700);
    const authDir = path.join(dir, "auths");
    privateDir(authDir);
    const cfg = path.join(dir, "config.yaml");
    writeConfig(cfg, authDir);
    const flag = mode === "device" ? "-codex-device-login" : "-codex-login";
    const child = spawn(executable, ["-config", cfg, flag, "-no-browser"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MANAGEMENT_PASSWORD: "" },
    });
    const flow = {
      provider,
      status: "waiting",
      authUrl: null,
      deviceCode: null,
      error: null,
      account: null,
      child,
      dir,
    };
    flows[provider] = flow;
    let output = "";
    let finalized = false;
    const consume = (chunk) => {
      output = (output + chunk.toString()).slice(-12000);
      const match = output.match(/https:\/\/auth\.openai\.com\/[^\s"'<>\x1b]+/);
      if (match) {
        try {
          const url = new URL(match[0]);
          if (url.protocol === "https:" && url.hostname === "auth.openai.com") {
            flow.authUrl = url.href;
          }
        } catch {}
      }
      const code = output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      if (code) flow.deviceCode = code[1];
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timeout = setTimeout(() => {
      flow.status = "failed";
      flow.error = "Sign-in timed out. Start again.";
      child.kill();
    }, 5 * 60_000);
    flow.timeout = timeout;
    child.once("error", () => {
      flow.status = "failed";
      flow.error =
        "Could not start CLIProxyAPI sign-in. Check the installation.";
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      if (finalized) return;
      finalized = true;
      try {
        if (flow.status !== "waiting") return;
        if (code !== 0)
          throw new HttpError(400, "Sign-in was not completed. Try again.");
        const files = fs
          .readdirSync(authDir)
          .filter((x) => x.endsWith(".json"));
        if (files.length !== 1) {
          const reason = /address already in use|bind:|EADDRINUSE/i.test(output)
            ? "The OAuth callback port is busy. Close other sign-in attempts and retry."
            : /403|PERMISSION_DENIED|access_denied/i.test(output)
              ? "The provider denied access. Check institutional app permissions and retry."
              : /EOF/i.test(output)
                ? "The sign-in process closed before the browser callback. Start again."
                : "Sign-in did not produce a credential. Retry and complete the provider consent screen.";
          throw new HttpError(400, reason);
        }
        flow.status = "verifying";
        const account = await admit(path.join(authDir, files[0]), provider);
        if (flow.status === "cancelled" || stopping) {
          credentials.delete(account.id);
          fs.rmSync(path.join(activeDir, account.id), { force: true });
          return;
        }
        flow.account = account;
        flow.status = "completed";
        onChange();
      } catch (error) {
        flow.status = "failed";
        flow.error = error.status
          ? error.message
          : "Could not verify this identity. Sign in again.";
      } finally {
        output = "";
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return publicFlow(flow);
  }
  return {
    key,
    port,
    status,
    notices,
    accounts,
    rawAccount,
    syncModels(models) {
      // Populate the bridge registry from authenticated account discovery, including hidden entries.
      // This changes routing metadata only; upstream still decides entitlement.
      const entries = models
        .filter(
          (m) => m.provider === "chatgpt" && m.discovery !== "bridge-candidate",
        )
        .map((m) => ({
          id: m.upstreamId,
          object: "model",
          owned_by: "openai",
          type: "codex",
          display_name: m.name,
          context_length: m.contextWindow || undefined,
          supportedInputModalities: m.inputModalities?.map((x) =>
            x.toUpperCase(),
          ),
          ...(m.reasoningLevels?.length
            ? { thinking: { levels: m.reasoningLevels } }
            : {}),
        }));
      if (!entries.length) return;
      const content = JSON.stringify(
        Object.fromEntries(
          ["codex-free", "codex-team", "codex-plus", "codex-pro"].map(
            (tier) => [tier, entries],
          ),
        ),
      );
      const nextPath = path.resolve(
        dataDir,
        `bridge-models-${hash(content).slice(0, 16)}.json`,
      );
      if (nextPath === catalogPath) return;
      privateWrite(nextPath, content);
      catalogPath = nextPath;
      store.set("bridge_catalog_path", nextPath);
      writeConfig(configPath, activeDir); // The bridge watches config changes and reloads the catalog.
    },
    initialize,
    start,
    startLogin,
    flows: () =>
      Object.fromEntries(
        Object.entries(flows).map(([k, f]) => [k, publicFlow(f)]),
      ),
    cancel(provider) {
      const flow = flows[provider];
      if (flow && ["waiting", "verifying"].includes(flow.status)) {
        flow.status = "cancelled";
        clearTimeout(flow.timeout);
        flow.child.kill();
      }
    },
    remove(id) {
      if (!credentials.has(id)) throw new HttpError(404, "Account not found.");
      credentials.delete(id);
      fs.rmSync(path.join(activeDir, id), { force: true });
      onChange();
    },
    async stop() {
      stopping = true;
      clearTimeout(restart);
      for (const flow of Object.values(flows)) {
        clearTimeout(flow.timeout);
        flow.child.kill();
      }
      if (proc) {
        const child = proc;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2000);
          child.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
          child.kill();
        });
      }
    },
  };
}
module.exports = { createBridge };
