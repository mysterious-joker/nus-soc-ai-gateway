const HOSTS = new Set([
  "auth.openai.com",
  "accounts.google.com",
  "antigravity.google",
  "soclaas-portal.comp.nus.edu.sg",
]);
function externalUrlAllowed(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (HOSTS.has(url.hostname) ||
        (url.hostname === "github.com" &&
          (url.pathname === "/mysterious-joker/nus-soc-ai-gateway" ||
            url.pathname.startsWith("/mysterious-joker/nus-soc-ai-gateway/"))))
    );
  } catch {
    return false;
  }
}
module.exports = { externalUrlAllowed };
