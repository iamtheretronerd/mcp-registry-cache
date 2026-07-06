# mcp-registry-cache

A **100% free, zero-maintenance** cache of the [Official MCP Registry](https://registry.modelcontextprotocol.io).

A GitHub Action runs on a schedule, downloads the full registry, and commits the
result as a single static [`registry.json`](./registry.json). Your application
reads that one file from a CDN — it **never** calls the Official MCP Registry
directly, so you have no rate limits, no API keys, no servers to run, and no
runtime dependency on a third-party service.

```
Official MCP Registry ──(GitHub Action, every 12h)──▶ registry.json ──(raw CDN)──▶ your app
```

---

## What this repository does

- Downloads every server from the Official MCP Registry (`GET /v0.1/servers`),
  following cursor pagination, keeping only the **latest version** of each server.
- Wraps each record in a stable, extensible envelope (see
  [Data format](#data-format)).
- Writes a **minified** `registry.json` (kept small for git and CDN delivery).
- Commits **only when the data actually changed**, so the schedule is silent on
  quiet days and git history stays clean.

The endpoint is defined once, in the `REGISTRY_ENDPOINT` constant at the top of
[`sync.js`](./sync.js), so it is trivial to re-point if the API version changes.

---

## Files

| File                          | Purpose                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `sync.js`                     | Downloads, validates, enriches, and writes the registry.      |
| `registry.json`               | The generated, committed, app-facing data (minified).         |
| `registry.pretty.json`        | Local-only pretty-printed copy for humans (git-ignored).      |
| `.github/workflows/sync.yml`  | Scheduled + manual GitHub Action that runs `sync.js`.         |
| `package.json`                | ESM project metadata. No dependencies.                        |

---

## How to run the sync manually

Requires **Node.js 20+** (uses the built-in `fetch`; no `npm install` needed).

```bash
node sync.js
# or
npm run sync
```

This writes `registry.json` (minified) and `registry.pretty.json` (readable).

You can also trigger it in the cloud without touching your machine: open the
repo's **Actions → Sync MCP Registry → Run workflow**.

---

## How GitHub Actions keeps it updated

[`.github/workflows/sync.yml`](./.github/workflows/sync.yml):

- Runs on a **cron schedule every 12 hours** (`0 */12 * * *`).
- Can be run on demand via **`workflow_dispatch`** (the "Run workflow" button).
- Executes `node sync.js`, then commits and pushes **only if `registry.json`
  changed** (`git status --porcelain` gate). No change ⇒ no commit.
- Needs no secrets — it uses the default `GITHUB_TOKEN` with `contents: write`.

> First-time setup: ensure **Settings → Actions → General → Workflow
> permissions** is set to **Read and write permissions** so the Action can push.

---

## How your application consumes it

Fetch the raw file from the GitHub CDN:

```
https://raw.githubusercontent.com/iamtheretronerd/mcp-registry-cache/main/registry.json
```

```js
const REGISTRY_URL =
  "https://raw.githubusercontent.com/iamtheretronerd/mcp-registry-cache/main/registry.json";

async function loadServers() {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
  const { metadata, servers } = await res.json();
  return servers; // metadata: { schemaVersion, source, generatedAt, count }
}
```

Prefer **GitHub Pages** if you want a custom domain or finer cache-control:
enable Pages for the repo (deploy from `main`) and serve `registry.json` from
`https://iamtheretronerd.github.io/mcp-registry-cache/registry.json`. Either way,
the consuming code only changes the URL constant.

---

## Data format

```jsonc
{
  "metadata": {
    "schemaVersion": 1,
    "source": "https://registry.modelcontextprotocol.io/v0.1/servers",
    "generatedAt": "2026-07-06T00:00:00.000Z",
    "count": 15292
  },
  "servers": [
    {
      "server": { /* verbatim record from the Official MCP Registry */ },
      "_meta":  { /* verbatim registry metadata (status, timestamps, …) */ },
      "_registry": {
        // Fields this cache owns — always present, safe for your app to rely on.
        "categories": [],
        "verified": false,
        "featured": false,
        "popularity": null,
        "screenshots": [],
        "custom": {}
      }
    }
  ]
}
```

The upstream record is preserved **verbatim** under `server` / `_meta`, so you
never lose data. Anything this project adds lives under the `_registry`
namespace.

---

## Extending it later (without changing your app's API)

The `_registry` namespace is a **stable contract**: those keys are always
present, so you can start populating them at any time and the application keeps
reading the same shape. To fill them in, add a small function to the `ENRICHERS`
array in [`sync.js`](./sync.js):

```js
const ENRICHERS = [
  // Mark first-party servers as verified.
  (entry) => ({
    verified: entry.server?.name?.startsWith("io.github.modelcontextprotocol/"),
  }),
  // Curate a featured set by name.
  (entry) => ({ featured: FEATURED.has(entry.server?.name) }),
];
```

Each enricher is a pure `(entry) => partialMeta` function whose result is merged
over the defaults. This makes the following easy to add incrementally:

- **filtering** — return early / drop entries in the pipeline, or add query
  params to `BASE_QUERY` (e.g. `search`, `updated_since`).
- **categories / verified / featured** — populate those `_registry` fields.
- **popularity metrics** — join against an external stats source in an enricher.
- **custom metadata / screenshots** — write into `_registry.custom` /
  `_registry.screenshots`.
- **local caching** — the committed `registry.json` *is* the cache; layer HTTP
  caching or a service worker on top in your app.

Bump `SCHEMA_VERSION` in `sync.js` if you ever make a breaking shape change.

---

## License

MIT
