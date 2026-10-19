const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = [
  "server.js",
  ...["lib", "public", "scripts", "test"].flatMap((dir) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((file) => file.endsWith(".js"))
      .map((file) => `${dir}/${file}`),
  ),
];
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--check", path.join(root, file)],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) process.exit(1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
