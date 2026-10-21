const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const tar = require("tar");
const yauzl = require("yauzl");
const { privateDir, HttpError } = require("./security");

// Reviewed upstream release assets. A changed download must never execute.
const VERSION = "8.0.25";
const ASSETS = {
  "darwin-arm64": [
    "darwin_aarch64.tar.gz",
    "d7e074ea78e91cfab2d871d24b8861d1eb27846c1bbc39030ccd368b2a70828c",
  ],
  "darwin-x64": [
    "darwin_amd64.tar.gz",
    "5416a0809510add8fbc03d003fb2cf6979e575bcf48a7c3bb562933c3cc6c3d5",
  ],
  "linux-arm64": [
    "linux_aarch64.tar.gz",
    "6a348af232e9bd137cb0ec10af5e26c10253c87eff4a1dc7784058ce14a13f5f",
  ],
  "linux-x64": [
    "linux_amd64.tar.gz",
    "257f3d3e0e1c388aea348a3d5bd7074b7ec1dd1da5c2f33d4144be6c9a43cc8e",
  ],
  "win32-arm64": [
    "windows_aarch64.zip",
    "1e53ee895f33d3e50d8a170dd181745c79f173851284a8ef9f24f3e06dfa6316",
  ],
  "win32-x64": [
    "windows_amd64.zip",
    "d64d46d39b733bbfbe2bc2dd63cf9a3dbfddf3d37bbf5e512b67c51e58729b49",
  ],
};
function executable(file, platform = process.platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(
      file,
      platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}
function resolveTool(
  name,
  {
    dataDir,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    home = os.homedir(),
  } = {},
) {
  const windows = platform === "win32";
  const filename = name + (windows ? ".exe" : "");
  const override = env[name === "agy" ? "AGY_BIN" : "CPA_BIN"];
  const search = (env.PATH || "")
    .split(windows ? ";" : ":")
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, filename));
  // An explicit invalid override must not silently select a different executable.
  if (override) {
    const file = path.isAbsolute(override)
      ? override
      : search.find((file) => path.basename(file) === override);
    return file && executable(file, platform)
      ? { path: file, source: "override" }
      : null;
  }
  const candidates = [
    ...(name === "cliproxyapi" && dataDir
      ? [
          [
            path.join(
              dataDir,
              "tools",
              `cliproxyapi-${VERSION}-${platform}-${arch}`,
              filename,
            ),
            "managed",
          ],
        ]
      : []),
    ...search.map((file) => [file, "PATH"]),
    ...[
      path.join(home, ".local/bin", filename),
      "/opt/homebrew/bin/" + filename,
      "/usr/local/bin/" + filename,
      ...(windows && env.LOCALAPPDATA
        ? [path.join(env.LOCALAPPDATA, "agy/bin", filename)]
        : []),
    ].map((file) => [file, "system"]),
  ];
  const found = candidates.find(([file]) => executable(file, platform));
  return found ? { path: found[0], source: found[1] } : null;
}
function verifyDigest(bytes, expected) {
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(
      "Download checksum did not match. Nothing was installed. Retry or report this release.",
    );
}
async function extractArchive(archive, destination, filename) {
  const allowed = new Set([filename, "LICENSE", "LICENSE.txt"]);
  if (archive.endsWith(".zip")) {
    await new Promise((resolve, reject) => {
      yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", (entry) => {
          if (!allowed.has(entry.fileName)) return zip.readEntry();
          const type = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            (type && type !== 0o100000) ||
            entry.uncompressedSize > 200 * 1024 * 1024
          ) {
            zip.close();
            return reject(new Error("Unsafe archive entry."));
          }
          zip.openReadStream(entry, async (error, stream) => {
            if (error) {
              zip.close();
              return reject(error);
            }
            try {
              await pipeline(
                stream,
                fs.createWriteStream(path.join(destination, entry.fileName), {
                  flags: "wx",
                  mode: 0o600,
                }),
              );
              zip.readEntry();
            } catch (error) {
              zip.close();
              reject(error);
            }
          });
        });
        zip.readEntry();
      });
    });
  } else {
    await tar.x({
      file: archive,
      cwd: destination,
      strict: true,
      preservePaths: false,
      filter: (name, entry) =>
        allowed.has(name) &&
        entry.type === "File" &&
        entry.size <= 200 * 1024 * 1024,
    });
  }
  const binary = path.join(destination, filename);
  if (!fs.existsSync(binary) || !fs.lstatSync(binary).isFile())
    throw new Error("Release archive did not contain the expected executable.");
  fs.chmodSync(binary, 0o700);
}
function createTools({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  fetcher = fetch,
} = {}) {
  let installing = false;
  let error = null;
  const resolve = (name) => resolveTool(name, { dataDir, platform, arch, env });
  return {
    resolve,
    status() {
      const bridge = resolve("cliproxyapi");
      const gemini = resolve("agy");
      return {
        platform,
        arch,
        bridge: {
          installed: !!bridge,
          source: bridge?.source,
          version: bridge?.source === "managed" ? VERSION : null,
          installing,
          error,
          canInstall: !!ASSETS[`${platform}-${arch}`] && !env.CPA_BIN,
        },
        gemini: { installed: !!gemini, supported: platform !== "win32" },
      };
    },
    async installBridge() {
      if (installing)
        throw new HttpError(
          409,
          "A connection-tool download is already in progress.",
        );
      if (env.CPA_BIN)
        throw new HttpError(
          409,
          "CPA_BIN is configured. Fix or remove that override before using managed setup.",
        );
      const asset = ASSETS[`${platform}-${arch}`];
      if (!asset)
        throw new HttpError(
          400,
          "No verified download is available for this platform. Install CLIProxyAPI manually and set CPA_BIN.",
        );
      if (resolve("cliproxyapi")?.source === "managed") return;
      installing = true;
      error = null;
      let temp;
      try {
        const root = path.join(dataDir, "tools");
        privateDir(root);
        temp = fs.mkdtempSync(path.join(root, ".install-"));
        fs.chmodSync(temp, 0o700);
        const archive = path.join(temp, asset[0]);
        const response = await fetcher(
          `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/CLIProxyAPI_${VERSION}_${asset[0]}`,
          { signal: AbortSignal.timeout(120_000) },
        );
        if (!response.ok || !response.body)
          throw new Error(
            "The connection tool could not be downloaded. Check your internet connection and retry.",
          );
        let size = 0;
        await pipeline(
          response.body,
          new Transform({
            transform(chunk, _, callback) {
              size += chunk.length;
              callback(
                size > 100 * 1024 * 1024
                  ? new Error("Download exceeded the size limit.")
                  : null,
                chunk,
              );
            },
          }),
          fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        );
        verifyDigest(fs.readFileSync(archive), asset[1]);
        const unpacked = path.join(temp, "unpacked");
        privateDir(unpacked);
        await extractArchive(
          archive,
          unpacked,
          platform === "win32" ? "cliproxyapi.exe" : "cliproxyapi",
        );
        const target = path.join(
          root,
          `cliproxyapi-${VERSION}-${platform}-${arch}`,
        );
        fs.renameSync(unpacked, target);
      } catch (cause) {
        error =
          "Connection-tool setup failed. Check your internet connection and retry. If it continues, report the app version and your operating system.";
        if (/checksum|expected executable/.test(cause.message))
          error = cause.message;
        throw new HttpError(502, error);
      } finally {
        if (temp) fs.rmSync(temp, { recursive: true, force: true });
        installing = false;
      }
    },
  };
}
module.exports = {
  createTools,
  resolveTool,
  verifyDigest,
  extractArchive,
  VERSION,
  ASSETS,
};
