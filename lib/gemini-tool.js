const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tar = require("tar");
const { privateDir, HttpError } = require("./security");
const { readResponse } = require("./media");

// Pinned from the manifests linked by Google's official CLI installer.
// https://antigravity.google/cli/install.sh (reviewed 2026-10-21)
const VERSION = "1.4.4";
const ROOT =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.4-4783783166214144/";
const ASSETS = {
  "darwin-arm64": [
    "darwin-arm/cli_mac_arm64.tar.gz",
    "cd12c4609b8b44aa94c2fe50eed8f3884f1ace506584630cbffcff428b0d557b883db0cc5fb9cfcc92528829c519857829070590c15ed6d673adf1916e609111",
  ],
  "darwin-x64": [
    "darwin-x64/cli_mac_x64.tar.gz",
    "aec91417bde35e690d55af4e1ae4ff621fdd67d6b68a7a9ab50ebb506bf99d6b8a3b40395a385a42f8cf97109df22febb67dbde5ca498e75cbbca57a0dadc9ac",
  ],
  "linux-x64": [
    "linux-x64/cli_linux_x64.tar.gz",
    "7ce149d350344c1046c7b59b6659bcc5d659f351bf3a07c6c085887d93427ceb89d927752e4ccd0844b53ffb91d33d6a49f72835ceb276c7cffdd13cfb8023b8",
  ],
  "linux-arm64": [
    "linux-arm/cli_linux_arm64.tar.gz",
    "7bfc4f7e5e2dda4cd0c536c72cf9725c2918a038028ad11fa4f7f5e57db77e9ff7d6b9beca05cd85618b77dd3e77de64b63629d33e5779f29111390dc53c7aaf",
  ],
};
const toolDirectory = (dataDir, platform, arch) =>
  path.join(dataDir, "tools", `antigravity-${VERSION}-${platform}-${arch}`);

async function installGeminiTool({
  dataDir,
  platform,
  arch,
  fetcher = fetch,
  signal,
}) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset)
    throw new HttpError(
      400,
      "Guided Gemini setup is available on macOS and Linux.",
    );
  const root = path.join(dataDir, "tools");
  privateDir(root);
  const temp = fs.mkdtempSync(path.join(root, "gemini-download-"));
  try {
    const response = await fetcher(ROOT + asset[0], {
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) throw new Error("Download failed.");
    const bytes = await readResponse(response, 150 * 1024 * 1024);
    if (crypto.createHash("sha512").update(bytes).digest("hex") !== asset[1])
      throw new Error(
        "Gemini download checksum did not match. Nothing was installed.",
      );
    const archive = path.join(temp, "cli.tar.gz");
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    const unpacked = path.join(temp, "unpacked");
    privateDir(unpacked);
    await tar.x({
      file: archive,
      cwd: unpacked,
      strict: true,
      preservePaths: false,
      filter: (name, entry) =>
        name === "antigravity" &&
        entry.type === "File" &&
        entry.size <= 300 * 1024 * 1024,
    });
    signal?.throwIfAborted();
    const binary = path.join(unpacked, "antigravity");
    if (!fs.existsSync(binary) || !fs.lstatSync(binary).isFile())
      throw new Error(
        "Gemini archive did not contain the expected executable.",
      );
    fs.renameSync(binary, path.join(unpacked, "agy"));
    fs.chmodSync(path.join(unpacked, "agy"), 0o700);
    fs.renameSync(unpacked, toolDirectory(dataDir, platform, arch));
  } catch (error) {
    throw new HttpError(
      502,
      /checksum|expected executable/.test(error.message)
        ? error.message
        : "Gemini setup download failed. Check your connection and try again.",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { VERSION, ASSETS, toolDirectory, installGeminiTool };
