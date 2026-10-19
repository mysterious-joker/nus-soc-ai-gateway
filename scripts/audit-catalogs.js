// Read-only provider enumeration; no generation requests or paid API fallback.
// The temporary gateway key is revoked in finally. Credentials never enter the report.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const root = path.resolve(__dirname, "..");
const dataDir = process.env.GATEWAY_DATA_DIR || path.join(root, "data");
const base = `http://localhost:${process.env.PORT || 4000}`;
const reportPath = path.join(
  process.env.GATEWAY_REPORT_DIR || path.join(root, "output"),
  "catalog-audit.json",
);
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
async function json(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(40_000),
  });
  if (!r.ok)
    throw new Error(
      `HTTP ${r.status}: ${new URL(url).origin}${new URL(url).pathname}`,
    );
  return { response: r, body: await r.json() };
}
async function main() {
  const startedAt = new Date().toISOString();
  const db = new DatabaseSync(path.join(dataDir, "command_center.db"), {
    readOnly: true,
  });
  const setting = (name) =>
    JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key=?").get(name)?.value ||
        "null",
    );
  const encrypted = setting("soclaas_secret");
  const expectedGemini = setting("gemini_cli_connection");
  db.close();
  let socKey;
  if (encrypted) {
    const [iv, tag, content] = encrypted
      .split(".")
      .map((x) => Buffer.from(x, "base64url"));
    const encryptionKey = crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(path.join(dataDir, "encryption-key"), "utf8").trim(),
      )
      .digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(tag);
    socKey = Buffer.concat([
      decipher.update(content),
      decipher.final(),
    ]).toString();
  }
  const login = await json(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: fs
        .readFileSync(path.join(dataDir, "dashboard-token"), "utf8")
        .trim(),
    }),
  });
  const admin = {
    Cookie: login.response.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": login.body.csrf,
    "Content-Type": "application/json",
  };
  let key;
  try {
    await json(base + "/api/refresh", { method: "POST", headers: admin });
    key = (
      await json(base + "/api/keys", {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "Temporary catalog audit" }),
      })
    ).body;
    const gateway = (
      await json(base + "/v1/models", {
        headers: { Authorization: `Bearer ${key.token}` },
      })
    ).body.data;
    const dashboard = (await json(base + "/api/dashboard", { headers: admin }))
      .body;
    const sources = [];
    const compare = (provider, ids, evidence) => {
      const upstream = [...new Set(ids)].sort();
      const local = gateway
        .filter((m) => m.owned_by === provider)
        .map((m) => m.id)
        .sort();
      return {
        provider,
        ...evidence,
        upstreamCount: upstream.length,
        gatewayCount: local.length,
        upstreamIds: upstream,
        gatewayIds: local,
        missingFromGateway: upstream.filter((id) => !local.includes(id)),
        additionalGatewayEntries: local.filter((id) => !upstream.includes(id)),
        duplicateUpstreamEntries: ids.length - upstream.length,
      };
    };
    // Enumerate the authenticated Codex catalog directly, without gateway normalization.
    const codexIds = [],
      accountEvidence = [];
    for (const file of (fs.existsSync(path.join(dataDir, "verified-auths"))
      ? fs.readdirSync(path.join(dataDir, "verified-auths"))
      : []
    ).filter((x) => x.endsWith(".json"))) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(dataDir, "verified-auths", file), "utf8"),
      );
      if (raw.type !== "codex") continue;
      const t = raw.tokens || raw.token || raw;
      const headers = {
        Authorization: `Bearer ${t.access_token}`,
        "User-Agent": "codex-cli/0.162.1",
      };
      if (t.account_id || raw.account_id)
        headers["Chatgpt-Account-Id"] = t.account_id || raw.account_id;
      const url =
        "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1";
      const { body } = await json(url, { headers });
      if (
        !Array.isArray(body.models) ||
        body.models.some((m) => !m.slug && !m.id)
      )
        throw new Error("Unrecognized Codex catalog");
      codexIds.push(...body.models.map((m) => `chatgpt/${m.slug || m.id}`));
      const publicResponse = await fetch("https://api.openai.com/v1/models", {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      await publicResponse.body?.cancel();
      accountEvidence.push({
        endpoint: url,
        httpStatus: 200,
        responseKeys: Object.keys(body),
        modelCount: body.models.length,
        modelMetadataSha256: digest(JSON.stringify(body.models)),
        publicApiCatalogHttpStatus: publicResponse.status,
      });
    }
    sources.push(
      compare("chatgpt", codexIds, {
        status: accountEvidence.length ? "audited" : "disconnected",
        scope:
          "Authenticated Codex model catalog; not the complete ChatGPT web feature catalog.",
        accounts: accountEvidence,
      }),
    );
    const pages = [],
      socIds = [],
      cursors = new Set();
    let after;
    for (let page = 0; socKey && page < 100; page++) {
      const url =
        "https://soclaas-api.comp.nus.edu.sg/v1/models" +
        (after ? "?after=" + encodeURIComponent(after) : "");
      const { body } = await json(url, {
        headers: { Authorization: `Bearer ${socKey}` },
      });
      if (!Array.isArray(body.data) || body.data.some((m) => !m.id))
        throw new Error("Unrecognized SoCLaaS catalog");
      socIds.push(...body.data.map((m) => `soclaas/${m.id}`));
      pages.push({
        endpoint: url,
        httpStatus: 200,
        responseKeys: Object.keys(body),
        count: body.data.length,
        hasMore: body.has_more ?? null,
        modelMetadataSha256: digest(JSON.stringify(body.data)),
      });
      if (!body.has_more) break;
      after = body.last_id || body.data.at(-1)?.id;
      if (!after || cursors.has(after) || page === 99)
        throw new Error("Incomplete SoCLaaS pagination");
      cursors.add(after);
    }
    sources.push(
      compare("soclaas", socIds, {
        status: socKey ? "audited" : "disconnected",
        scope: "All entries returned by the authenticated /v1/models API.",
        pages,
        paginationCompleted: Boolean(socKey),
        terminationReason: !socKey
          ? "Source not connected."
          : pages.at(-1).hasMore === null
            ? "Response did not advertise has_more; completeness beyond this API response is not independently asserted."
            : "Provider explicitly returned has_more=false.",
      }),
    );
    if (expectedGemini) {
      const log = path.join(
        os.tmpdir(),
        `nus-catalog-audit-${crypto.randomUUID()}.log`,
      );
      fs.writeFileSync(log, "", { mode: 0o600 });
      try {
        const env = Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG"]
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        );
        const { stdout } = await promisify(execFile)(
          process.env.AGY_BIN || path.join(os.homedir(), ".local/bin/agy"),
          ["--log-file", log, "models"],
          {
            cwd: path.join(dataDir, "gemini-cli-workspace"),
            env,
            timeout: 35_000,
            maxBuffer: 1024 * 1024,
          },
        );
        const logs = fs.readFileSync(log, "utf8");
        const identity = logs.match(
          /applyAuthResult: email=([^,\s]+), authMethod=(\w+), quotaProject=([^\s]+)/,
        );
        if (
          !identity ||
          identity[2] !== "gcp" ||
          identity[1] !== expectedGemini.email ||
          identity[3] !== expectedGemini.project ||
          !logs.includes("authenticated via keyring (effective: gcp)")
        )
          throw new Error("CLI subscription identity could not be matched");
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (!lines.length || lines.some((line) => !/^[\w.-]+\t.+$/.test(line)))
          throw new Error("Unrecognized CLI model list");
        sources.push(
          compare(
            "gemini",
            lines.map((line) => "gemini/" + line.split("\t")[0]),
            {
              status: "audited",
              scope:
                "CLI selectable reasoning models; excludes tool backends and Gemini web features.",
              command: "agy models",
              authenticatedSchoolAccountMatched: true,
              project: expectedGemini.project,
              cliVersion:
                logs.match(/Language server version:\s*([^\s]+)/)?.[1] || null,
              rawCatalog: stdout.trim(),
              catalogSha256: digest(stdout),
            },
          ),
        );
      } finally {
        fs.rmSync(log, { force: true });
      }
    } else sources.push(compare("gemini", [], { status: "disconnected" }));
    if (sources.some((s) => s.missingFromGateway.length)) process.exitCode = 1;
    const report = {
      startedAt,
      checkedAt: new Date().toISOString(),
      universalSubscriptionCoverageProven: false,
      scope:
        "Set comparison of fresh connector catalogs against the running local API. This does not prove all subscription capabilities or free billing entitlement.",
      sources,
      generationTests: {
        rerunDuringThisAudit: false,
        note: "Historical successful requests demonstrate reachability at their timestamps, not entitlement completeness or future availability.",
        models: dashboard.models.map((m) => ({
          id: m.id,
          type: m.type,
          discovery: m.discovery || "cli-catalog",
          verification: m.verification,
        })),
      },
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          report: reportPath,
          checkedAt: report.checkedAt,
          sources: sources.map(
            ({
              provider,
              upstreamCount,
              gatewayCount,
              missingFromGateway,
              additionalGatewayEntries,
            }) => ({
              provider,
              upstreamCount,
              gatewayCount,
              missingFromGateway,
              additionalGatewayEntries,
            }),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    if (key)
      await json(base + "/api/keys?id=" + encodeURIComponent(key.id), {
        method: "DELETE",
        headers: admin,
      });
    await json(base + "/api/session", { method: "DELETE", headers: admin });
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
