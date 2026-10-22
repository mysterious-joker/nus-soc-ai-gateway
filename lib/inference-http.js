const { Agent } = require("undici");

// Keep transport deadlines outside the gateway's 600-second inference limit.
// A signal alone does not extend fetch's default header/body timeouts.
const dispatcher = new Agent({
  headersTimeout: 630_000,
  bodyTimeout: 630_000,
});
function inferenceFetch(url, options) {
  return fetch(url, { ...options, dispatcher });
}
module.exports = { inferenceFetch };
