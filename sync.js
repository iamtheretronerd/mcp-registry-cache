#!/usr/bin/env node
/**
 * sync.js — Mirror the Official MCP Registry into a single static `registry.json`.
 *
 * This script:
 *   1. Downloads every server record from the Official MCP Registry (paginated).
 *   2. Validates each response.
 *   3. Runs each record through an extensible enrichment pipeline.
 *   4. Writes a minified `registry.json` (app-facing) plus a git-ignored
 *      pretty-printed `registry.pretty.json` (for humans).
 *   5. Exits with a non-zero status if the download fails.
 *
 * It has zero runtime dependencies — it relies only on the native `fetch`
 * available in Node.js 20+.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The Official MCP Registry "list servers" endpoint.
 *
 * Documented at https://registry.modelcontextprotocol.io/docs. Keeping it in a
 * single constant means the whole pipeline can be re-pointed by editing one
 * line (e.g. if the API version bumps from `v0.1` to `v1`).
 */
const REGISTRY_ENDPOINT =
  "https://registry.modelcontextprotocol.io/v0.1/servers";

/** Maximum page size the endpoint accepts (`expected number <= 100`). */
const PAGE_SIZE = 100;

/**
 * Query parameters applied to every page request.
 *
 * `version=latest` collapses the many historical versions of each server down
 * to a single record — what a marketplace actually needs, and roughly a third
 * of the payload. Add future filters here (e.g. `include_deleted`) without
 * touching the pagination logic.
 */
const BASE_QUERY = Object.freeze({
  version: "latest",
});

/** Bumped whenever the shape of `registry.json` changes in a breaking way. */
const SCHEMA_VERSION = 1;

const HERE = dirname(fileURLToPath(import.meta.url));

/** App-facing output: minified to keep the file (and git history) small. */
const OUTPUT_FILE = join(HERE, "registry.json");

/**
 * Human-readable copy for debugging/inspection. This is intentionally NOT
 * committed (see .gitignore) — it only mirrors the committed file, formatted.
 */
const DEBUG_FILE = join(HERE, "registry.pretty.json");

/** Network tuning for CI resilience. */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/* -------------------------------------------------------------------------- */
/* Enrichment pipeline                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Default values for every field the *application* is allowed to rely on.
 *
 * These live under a dedicated `_registry` namespace on each server so they
 * never collide with upstream fields. Because the application always sees these
 * keys (even when empty), we can start populating them later — filtering,
 * categories, verified/featured flags, popularity, screenshots, custom
 * metadata — WITHOUT changing the application's contract.
 */
const REGISTRY_META_DEFAULTS = Object.freeze({
  categories: [],
  verified: false,
  featured: false,
  popularity: null,
  screenshots: [],
  custom: {},
});

/**
 * An enricher is a pure function `(entry) => Partial<typeof REGISTRY_META_DEFAULTS>`.
 * Outputs are shallow-merged over the defaults, in order.
 *
 * To add a new capability later (e.g. categorisation or a "featured" list),
 * push another function here. Nothing else in the file — or in the consuming
 * application — needs to change.
 *
 * @type {Array<(entry: object) => object>}
 */
const ENRICHERS = [
  // Example (disabled): mark servers published by trusted namespaces as verified.
  // (entry) => ({ verified: entry.server?.name?.startsWith("io.github.modelcontextprotocol/") }),
];

/**
 * Apply the enrichment pipeline to a single raw registry entry.
 *
 * The upstream record (`{ server, _meta }`) is preserved verbatim for maximum
 * compatibility; our additions live under `_registry`.
 *
 * @param {object} entry Raw `{ server, _meta }` record from the API.
 * @returns {object} The entry with a populated `_registry` namespace.
 */
function enrichEntry(entry) {
  const registryMeta = ENRICHERS.reduce(
    (acc, enrich) => ({ ...acc, ...enrich(entry) }),
    { ...REGISTRY_META_DEFAULTS }
  );

  return { ...entry, _registry: registryMeta };
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch JSON with a timeout and exponential-backoff retries.
 *
 * @param {string} url
 * @returns {Promise<object>} Parsed JSON body.
 */
async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === MAX_RETRIES;
      console.warn(
        `  ! Request failed (attempt ${attempt}/${MAX_RETRIES}): ${error.message}` +
          (isLastAttempt ? "" : " — retrying…")
      );
      if (!isLastAttempt) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `Failed to fetch ${url} after ${MAX_RETRIES} attempts: ${lastError.message}`
  );
}

/* -------------------------------------------------------------------------- */
/* Registry download                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validate that a page response has the shape we expect before trusting it.
 *
 * @param {any} page
 * @returns {{ servers: object[], nextCursor: string | undefined }}
 */
function validatePage(page) {
  if (!page || typeof page !== "object" || !Array.isArray(page.servers)) {
    throw new Error(
      "Unexpected response shape: expected an object with a `servers` array."
    );
  }
  return { servers: page.servers, nextCursor: page.metadata?.nextCursor };
}

/**
 * Download every server record by following cursor-based pagination.
 *
 * @returns {Promise<object[]>} All raw `{ server, _meta }` records.
 */
async function downloadAllServers() {
  const servers = [];
  let cursor;
  let pageNumber = 0;

  do {
    const url = new URL(REGISTRY_ENDPOINT);
    url.searchParams.set("limit", String(PAGE_SIZE));
    for (const [key, value] of Object.entries(BASE_QUERY)) {
      url.searchParams.set(key, value);
    }
    if (cursor) url.searchParams.set("cursor", cursor);

    pageNumber += 1;
    console.log(`→ Fetching page ${pageNumber}${cursor ? ` (cursor ${cursor})` : ""}…`);

    const { servers: pageServers, nextCursor } = validatePage(
      await fetchJson(url.toString())
    );

    servers.push(...pageServers);
    cursor = nextCursor;
  } while (cursor);

  return servers;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read the previously generated registry, if one exists.
 *
 * @returns {Promise<object | null>}
 */
async function readExistingRegistry() {
  try {
    return JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
  } catch {
    return null; // Missing or unparseable — treat as a first run.
  }
}

/**
 * `generatedAt` alone must never trigger a commit, otherwise the GitHub Action
 * would churn on every scheduled run. We therefore consider two registries
 * "equal" when everything *except* `generatedAt` matches, and reuse the old
 * timestamp so the output file stays byte-for-byte identical.
 *
 * @param {object} next  Freshly built registry (without a final timestamp).
 * @param {object | null} previous  Previously written registry, if any.
 * @returns {boolean} True when only the timestamp would differ.
 */
function isUnchanged(next, previous) {
  if (!previous) return false;
  const strip = ({ metadata: { generatedAt, ...meta } = {}, ...rest }) =>
    JSON.stringify({ ...rest, metadata: meta });
  return strip(next) === strip(previous);
}

async function main() {
  console.log(`Syncing from ${REGISTRY_ENDPOINT}`);

  const rawServers = await downloadAllServers();
  if (rawServers.length === 0) {
    throw new Error("Registry returned zero servers — refusing to overwrite.");
  }

  const registry = {
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      source: REGISTRY_ENDPOINT,
      generatedAt: new Date().toISOString(),
      count: rawServers.length,
    },
    servers: rawServers.map(enrichEntry),
  };

  // Preserve the previous timestamp when nothing else changed, so the workflow's
  // "commit only if changed" check sees an identical file and skips the commit.
  const previous = await readExistingRegistry();
  if (isUnchanged(registry, previous)) {
    registry.metadata.generatedAt = previous.metadata.generatedAt;
    console.log("• No changes since last sync — output left untouched.");
  }

  // Committed artifact: minified (with trailing newline for clean diffs).
  await writeFile(OUTPUT_FILE, `${JSON.stringify(registry)}\n`, "utf8");
  // Local-only artifact: pretty-printed for human inspection (git-ignored).
  await writeFile(DEBUG_FILE, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  console.log(`✓ Wrote ${registry.servers.length} servers to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(`✗ Sync failed: ${error.message}`);
  process.exit(1);
});
