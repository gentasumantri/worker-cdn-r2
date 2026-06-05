const ALLOWED_METHODS = new Set(["GET", "HEAD"])

function isFilePath(pathname) {
  return pathname.length > 1 && !pathname.endsWith("/")
}

export default {
  async fetch(request, env, ctx) {
    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      })
    }

    const url = new URL(request.url)
    if (!isFilePath(url.pathname)) {
      return new Response("Not Found", { status: 404 })
    }

    // PUBLIC_PATH_PREFIX selects what gets served without auth and cached:
    //   "<prefix>" : only /<prefix>/* is public, rest requires HMAC token
    //   "*"        : every path is public (no token check)
    //   unset      : nothing is public (every path requires HMAC token)
    const publicPrefix = env.PUBLIC_PATH_PREFIX
    const isPublic = publicPrefix === "*" || (publicPrefix && url.pathname.startsWith(`/${publicPrefix}/`))

    if (isPublic) {
      return servePublic(request, url, env, ctx)
    }
    return servePrivate(request, url, env)
  },
}

async function servePublic(request, url, env, ctx) {
  const range = request.headers.get("range")
  const cache = caches.default

  // Skip cache for range requests so a 206 doesn't get served from a 200 entry.
  if (!range && request.method === "GET") {
    const cached = await cache.match(url.toString())
    if (cached) return cached
  }

  const ttl = Number(env.PUBLIC_CACHE_TTL ?? 86400)
  const response = await serveFromR2(request, url, env, {
    "Cache-Control": `public, max-age=${ttl}, immutable`,
  })

  if (!range && request.method === "GET" && response.status === 200) {
    ctx.waitUntil(cache.put(url.toString(), response.clone()))
  }
  return response
}

async function servePrivate(request, url, env) {
  const exp = url.searchParams.get("exp")
  const sig = url.searchParams.get("sig")
  if (!exp || !sig) return new Response("Forbidden", { status: 403 })

  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) {
    return new Response("Forbidden", { status: 403 })
  }

  const expected = await hmacHex(env.SIGNING_KEY, `${url.pathname}\n${exp}`)
  if (!timingSafeEqualHex(sig, expected)) {
    return new Response("Forbidden", { status: 403 })
  }

  return serveFromR2(request, url, env, {
    "Cache-Control": "private, no-store",
  })
}

async function serveFromR2(request, url, env, extraHeaders) {
  const key = decodeURIComponent(url.pathname.slice(1))

  if (request.method === "HEAD") {
    const obj = await env.BUCKET.head(key)
    if (!obj) return new Response("Not Found", { status: 404 })
    return buildResponse(obj, null, null, extraHeaders)
  }

  const range = request.headers.get("range")
  const parsedRange = range ? parseRange(range) : undefined
  const obj = await env.BUCKET.get(key, parsedRange ? { range: parsedRange } : undefined)
  if (!obj) return new Response("Not Found", { status: 404 })

  return buildResponse(obj, obj.body, parsedRange, extraHeaders)
}

function buildResponse(obj, body, parsedRange, extraHeaders) {
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set("ETag", obj.httpEtag)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Accept-Ranges", "bytes")
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)

  if (parsedRange && body && obj.range) {
    const start = obj.range.offset ?? 0
    const length = obj.range.length ?? obj.size - start
    const end = start + length - 1
    headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`)
    headers.set("Content-Length", String(length))
    return new Response(body, { status: 206, headers })
  }

  headers.set("Content-Length", String(obj.size))
  return new Response(body, { status: 200, headers })
}

function parseRange(header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match) return undefined
  const start = match[1] === "" ? undefined : Number(match[1])
  const end = match[2] === "" ? undefined : Number(match[2])
  if (start !== undefined && end !== undefined) {
    return { offset: start, length: end - start + 1 }
  }
  if (start !== undefined) return { offset: start }
  if (end !== undefined) return { suffix: end }
  return undefined
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
