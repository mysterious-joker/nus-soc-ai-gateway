const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const dir = process.env.GATEWAY_DATA_DIR || path.join(__dirname, "..", "data");
try {
  const token = fs
    .readFileSync(path.join(dir, "dashboard-token"), "utf8")
    .trim();
  const url = `http://localhost:${Number(process.env.PORT || 4000)}/#token=${encodeURIComponent(token)}`;
  execFile("open", [url], (error) => {
    if (error) {
      console.error(
        "Could not open the browser. Open localhost:4000 and use the token in data/dashboard-token.",
      );
      process.exitCode = 1;
    }
  });
} catch {
  console.error("Start the gateway with npm start first.");
  process.exitCode = 1;
}
