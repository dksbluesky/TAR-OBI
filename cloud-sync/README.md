# Optional iPhone Cloud Bridge Sync

This dedicated Cloudflare Worker stores one current ETF_DCA/TAR-OBI Bridge per pairing key in D1. It is **off by default**. Existing PC and tablet local Bridge behavior remains available. The Worker does not fetch market data and does not receive a Fugle key.

## Cloudflare setup

The dedicated `tar-obi-bridge-sync` D1 database and Worker use the checked-in `wrangler.toml`. To apply the table and redeploy from this directory, run `npx wrangler d1 execute tar-obi-bridge-sync --remote --file=./schema.sql` and `npx wrangler deploy`.

The Worker URL is prefilled in both apps. In ETF_DCA Settings on the iPhone, generate a pairing key and enable Cloud Sync. Copy the same key into standalone TAR-OBI Dashboard Settings and enable it there. Start a **new** TAR-OBI Monitor from ETF_DCA Entry Watch. This publishes the current complete Bridge before TAR-OBI opens. The standalone TAR-OBI app reads it when opened or resumed; it checks again while visible. TAR-OBI assessment updates are sent back to the Worker.

Do not put the pairing key in source code, a GitHub issue, or a screenshot. Each app keeps it in its own device-local storage. A lost key cannot be recovered from the Worker; a new key starts an empty sync account. Disable Cloud Sync in either app to return to its existing local behavior. A cloud error leaves local data in place and shows a status warning.

Local checks: `node tests/cloud-sync-worker.test.mjs` and `node tests/cloud-bridge-client.test.js`. The ETF_DCA checkout has `node execution-bridge-cloud.test.js`. These do not prove iOS PWA behavior; that needs a published Worker and a device test.
