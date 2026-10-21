const test = require("node:test");
const assert = require("node:assert/strict");
const { externalUrlAllowed } = require("../desktop/policy");
test("desktop opens only approved HTTPS authentication and project links externally", () => {
  for (const url of [
    "https://auth.openai.com/authorize?state=test",
    "https://antigravity.google/docs/getting-started?tab=cli",
    "https://github.com/mysterious-joker/nus-soc-ai-gateway/releases/latest",
  ])
    assert.equal(externalUrlAllowed(url), true, url);
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://auth.openai.com",
    "https://auth.openai.com.evil.test",
    "https://user:password@auth.openai.com",
    "https://auth.openai.com:8443",
    "https://github.com/mysterious-joker/nus-soc-ai-gateway-evil",
    "https://evil.test",
    "not a url",
  ])
    assert.equal(externalUrlAllowed(url), false, url);
});
