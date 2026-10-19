const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const {
  privateDir,
  privateWrite,
  secretFile,
  hash,
  random,
  HttpError,
} = require("./security");
function createStore(dataDir) {
  privateDir(dataDir);
  const dbPath = path.join(dataDir, "command_center.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL UNIQUE, is_master INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, api_key_id TEXT, api_key_name TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, latency_ms INTEGER DEFAULT 0, status_code INTEGER DEFAULT 200, is_stream INTEGER DEFAULT 0, error_message TEXT DEFAULT '', prompt_preview TEXT DEFAULT '');`);
  const columns = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  if (!columns("api_keys").includes("hint"))
    db.exec("ALTER TABLE api_keys ADD COLUMN hint TEXT DEFAULT ''");
  if (!columns("usage_logs").includes("usage_source"))
    db.exec(
      "ALTER TABLE usage_logs ADD COLUMN usage_source TEXT DEFAULT 'legacy'",
    );
  db.exec(
    "CREATE INDEX IF NOT EXISTS usage_time ON usage_logs(timestamp); CREATE INDEX IF NOT EXISTS usage_model ON usage_logs(provider,model)",
  );
  for (const key of db.prepare("SELECT * FROM api_keys").all()) {
    if (!key.api_key.startsWith("sha256:"))
      db.prepare("UPDATE api_keys SET api_key=?, hint=? WHERE id=?").run(
        "sha256:" + hash(key.api_key),
        key.api_key.slice(-4),
        key.id,
      );
  }
  // The encryption key is local, owner-readable only. It protects accidental DB-only disclosure.
  const encryptionKey = crypto
    .createHash("sha256")
    .update(secretFile(path.join(dataDir, "encryption-key")))
    .digest();
  function get(key, fallback = null) {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  function set(key, value) {
    db.prepare(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, JSON.stringify(value));
  }
  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  function decrypt(value) {
    if (!value) return "";
    const [iv, tag, data] = value
      .split(".")
      .map((x) => Buffer.from(x, "base64url"));
    const cipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString();
  }
  const legacy = get("soclaas_config");
  if (legacy?.apiKey) {
    set("soclaas_secret", encrypt(legacy.apiKey));
    delete legacy.apiKey;
    set("soclaas_config", legacy);
  }
  // Removed provider: discard active Gemini settings and credentials on upgrade.
  for (const key of [
    "gemini_api_config",
    "gemini_oauth_secret",
    "gemini_api_access",
  ])
    db.prepare("DELETE FROM settings WHERE key=?").run(key);
  db.prepare(
    "UPDATE usage_logs SET prompt_preview='' WHERE prompt_preview<>''",
  ).run();
  for (const suffix of ["", "-wal", "-shm"])
    if (fs.existsSync(dbPath + suffix)) fs.chmodSync(dbPath + suffix, 0o600);
  return {
    db,
    get,
    set,
    soclaasKey: () => decrypt(get("soclaas_secret", "")),
    setSoclaasKey: (key) => set("soclaas_secret", key ? encrypt(key) : ""),
    keys: () =>
      db
        .prepare(
          "SELECT id,name,hint,created_at FROM api_keys ORDER BY created_at DESC",
        )
        .all(),
    createKey(name) {
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        throw new HttpError(400, "Enter a key name of 1–80 characters.");
      const token = "sk-nus-" + random();
      const key = {
        id: crypto.randomUUID(),
        name: name.trim(),
        hint: token.slice(-4),
        created_at: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO api_keys(id,name,api_key,created_at,hint) VALUES(?,?,?,?,?)",
      ).run(
        key.id,
        key.name,
        "sha256:" + hash(token),
        key.created_at,
        key.hint,
      );
      return { ...key, token };
    },
    authenticate(req) {
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || "");
      if (!match)
        throw new HttpError(
          401,
          "A gateway API key is required in the Bearer authorization header.",
        );
      const key = db
        .prepare("SELECT id,name FROM api_keys WHERE api_key=?")
        .get("sha256:" + hash(match[1]));
      if (!key) throw new HttpError(401, "Invalid gateway API key.");
      return key;
    },
    revokeKey(id) {
      db.prepare("DELETE FROM api_keys WHERE id=?").run(id);
    },
    record(log) {
      db.prepare(
        `INSERT INTO usage_logs(timestamp,api_key_id,api_key_name,provider,model,endpoint,prompt_tokens,completion_tokens,total_tokens,latency_ms,status_code,is_stream,error_message,usage_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        new Date().toISOString(),
        log.key?.id || "playground",
        log.key?.name || "Playground",
        log.provider,
        log.model,
        log.endpoint,
        log.usage?.input || 0,
        log.usage?.output || 0,
        log.usage?.total || 0,
        Date.now() - log.started,
        log.status,
        log.stream ? 1 : 0,
        log.error || "",
        log.usage ? "reported" : "unavailable",
      );
    },
    analytics(timeframe = "all") {
      const cutoff =
        timeframe === "24h"
          ? new Date(Date.now() - 86400_000).toISOString()
          : timeframe === "7d"
            ? new Date(Date.now() - 7 * 86400_000).toISOString()
            : "";
      const sums = `COUNT(*) AS requests, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS successful, COALESCE(SUM(prompt_tokens),0) AS input, COALESCE(SUM(completion_tokens),0) AS output, COALESCE(SUM(total_tokens),0) AS tokens, SUM(CASE WHEN usage_source='reported' THEN 1 ELSE 0 END) AS reported, SUM(CASE WHEN usage_source='legacy' THEN 1 ELSE 0 END) AS legacy`;
      return {
        totals: db
          .prepare(`SELECT ${sums} FROM usage_logs WHERE timestamp>=?`)
          .get(cutoff),
        byProvider: db
          .prepare(
            `SELECT provider,${sums} FROM usage_logs WHERE timestamp>=? GROUP BY provider`,
          )
          .all(cutoff),
        byModel: db
          .prepare(
            `SELECT provider,model,${sums} FROM usage_logs WHERE timestamp>=? GROUP BY provider,model ORDER BY tokens DESC`,
          )
          .all(cutoff),
        recent: db
          .prepare(
            "SELECT timestamp,provider,model,endpoint,total_tokens,usage_source,status_code,latency_ms FROM usage_logs WHERE timestamp>=? ORDER BY id DESC LIMIT 50",
          )
          .all(cutoff),
      };
    },
  };
}
module.exports = { createStore };
