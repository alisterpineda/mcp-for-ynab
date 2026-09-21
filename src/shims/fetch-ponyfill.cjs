// Build-time replacement for `fetch-ponyfill`, which the ynab SDK requires unconditionally but
// only uses when `globalThis.fetch` is missing. Node 22+ always has fetch, so this keeps
// node-fetch out of the bundle. Wired up via the esbuild --alias flag in package.json.
module.exports = function fetchPonyfill() {
  return {
    fetch: globalThis.fetch,
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
  };
};
