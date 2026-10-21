const { execFile } = require("node:child_process");
function browserCommand(url, platform = process.platform) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(parsed.hostname)
  )
    throw new Error("Only a local gateway URL can be opened.");
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32")
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}
function openBrowser(url) {
  const [command, args] = browserCommand(url);
  return new Promise((resolve, reject) =>
    execFile(command, args, (error) => (error ? reject(error) : resolve())),
  );
}
module.exports = { browserCommand, openBrowser };
