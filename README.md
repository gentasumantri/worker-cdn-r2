# worker-cdn-r2

Cloudflare Worker that fronts a private R2 bucket as a CDN via R2 bindings (no SigV4, no presigned URLs). Public prefix
cached at the edge, HMAC-signed token enforcement for private paths.

> If your upstream is an S3-compatible bucket (Backblaze B2, Linode, DO Spaces, AWS S3, etc.), see
> [worker-cdn-s3](https://github.com/gentasumantri/worker-cdn-s3), which uses SigV4 via `aws4fetch` instead of R2
> bindings.

## How it works

- **Public prefix** (set via `PUBLIC_PATH_PREFIX`): Worker reads straight from the R2 binding, response cached at
  Cloudflare. No auth. Anyone with the URL can fetch; use unguessable keys (CUID, UUID).
- **Everything else**: HMAC-signed token enforcement. App server signs `<path>\n<exp>` with a shared `SIGNING_KEY` and
  appends `?exp=<unix>&sig=<hex>`. Worker validates before reading from R2.

`PUBLIC_PATH_PREFIX` modes:

| Value           | Behavior                                                           |
| --------------- | ------------------------------------------------------------------ |
| `<path-prefix>` | `/<path-prefix>/*` served from R2 and cached, rest requires token  |
| `*`             | every path served from R2 and cached (no token check, full public) |
| unset           | no public route, every path requires an HMAC-signed token          |

Read-only. No writes, no listing, no bucket config access through this Worker.

## Deployment

### Manual

```bash
git clone git@github.com:gentasumantri/worker-cdn-r2.git
cd worker-cdn-r2
npm install
# Set binding, vars, and secrets in CF dashboard (see Configuration), then:
npm run deploy
```

### Auto via Workers Builds

Connect the GitHub repo in **Worker > Settings > Build > Git integration**. To deploy under a custom name (e.g.
`cdn-dev`), set the **Deploy command**:

```bash
npx wrangler deploy --name cdn-dev
```

Binding, vars, and secrets must be set in the dashboard before the first build.

## Configuration

### 1. R2 bucket

Create a private R2 bucket. Do not enable public access; the Worker is the only path to the bucket.

```bash
npx wrangler r2 bucket create <bucket-name>
```

Or via dashboard at **R2 > Create bucket**.

### 2. R2 binding

Set in **Worker > Settings > Bindings > Add > R2 bucket**:

| Field         | Value              |
| ------------- | ------------------ |
| Variable name | `BUCKET`           |
| R2 bucket     | bucket from step 1 |

Binding name must be `BUCKET` so `env.BUCKET` resolves in `src/index.js`. Bindings set in the dashboard persist across
deploys because the toml declares none.

Alternative: uncomment the `[[r2_buckets]]` block in `wrangler.toml` and fill in `bucket_name`.

### 3. Variables and secrets

Set in **Worker > Settings > Variables and Secrets**:

| Type     | Name                 | Value                                                            |
| -------- | -------------------- | ---------------------------------------------------------------- |
| Variable | `PUBLIC_PATH_PREFIX` | optional, see How it works                                       |
| Variable | `PUBLIC_CACHE_TTL`   | edge cache seconds for public route (e.g. `86400`)               |
| Secret   | `SIGNING_KEY`        | high-entropy string (e.g. `openssl rand -hex 32`) for HMAC token |

`SIGNING_KEY` is only used when there is a private route. For full-public mode (`PUBLIC_PATH_PREFIX=*`) it can be
omitted.

Alternative for local dev or non-public deploys: uncomment the `[vars]` block in `wrangler.toml`. The secret always goes
through `wrangler secret put` or the dashboard. Never in the toml.

### 4. Custom domain

Add via **Worker > Settings > Domains & Routes > Add Custom Domain**. Routes set in the dashboard persist across deploys
because the toml declares none.

### 5. App-side token signing (private mode)

For paths not covered by `PUBLIC_PATH_PREFIX`, the app server signs the URL before returning it to the client. The
`SIGNING_KEY` must match the Worker's secret.

```ts
import { createHmac } from "node:crypto"

function signUrl(path: string, ttlSeconds = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = createHmac("sha256", process.env.SIGNING_KEY).update(`${path}\n${exp}`).digest("hex")
  return `${process.env.CDN_BASE_URL}${path}?exp=${exp}&sig=${sig}`
}

// After authorizing the user:
const url = signUrl("/files/user123/report.pdf")
```

TTL of 5 to 15 minutes is typical. Each path gets its own token.

## Verification

```bash
# CDN public path (cached after first MISS):
curl -I https://cdn.example.com/public/avatars/<id>          # 200

# CDN private path requires valid token:
curl -I https://cdn.example.com/files/<key>                  # 403 without token
curl -I "https://cdn.example.com/files/<key>?exp=<unix>&sig=<hex>"  # 200; 403 if tampered or expired
```

## Operations

```bash
npm run dev    # local Worker (reads vars from wrangler.toml [vars])
npm run tail   # tail production logs
```

## Development

```bash
npm install
npm run format    # prettier: auto-format
npm run check     # prettier: check formatting (CI)
```
