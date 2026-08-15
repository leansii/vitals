# vitals

A tiny cron-triggered [Cloudflare Worker](https://developers.cloudflare.com/workers/)
that watches the health of **several independent projects** from a single deploy
and alerts to Telegram when something breaks.

For each project it:

- fetches the backend's deep health endpoint (`/healthz/deep` by default) with an
  `X-Health-Key` header and reports every failed dependency check;
- compares the endpoint's config self-audit against the **expected prod config**
  and alerts on drift (the env-var tripwire);
- alerts on a **client-error spike** (N new error signatures in the last 15 min);
- GET-probes the project's **frontends** and alerts when one stops serving.

Alerts are **edge-triggered per project**: a target alerts when its problem
signature *changes* and sends a 🟢 recovery message when it clears — a two-hour
outage is one message, not eight. Targets are probed concurrently and hold
independent state, so a broken project never delays or masks the others.

```
🔴 [cyclecare-api] vitals: 2 problem(s)
• @ api.getcyclecare.com check database FAILED (15002ms): timeout
• [web] https://app.getcyclecare.com returned 502
```

Free tier all the way down: a Worker on the `*/15` cron is ~96 runs/day, well
inside Cloudflare's free limits.

## What your backend has to expose

One JSON endpoint. Every field is optional except `status` — vitals only checks
what is present:

```jsonc
{
  "status": "ok",
  "checks": [{ "name": "database", "ok": true, "latency_ms": 42, "detail": "" }],
  "config": [{ "feature": "auth", "state": "on", "detail": "firebase" }],
  "client_errors": { "new_signatures_15m": 0, "total_errors_24h": 12 }
}
```

Gate it behind a shared secret compared against the `X-Health-Key` header, and
return **404** when the key does not match — vitals reports a 404 on that route
as "health key mismatch or endpoint not deployed" rather than an outage. The
endpoint should answer with JSON even when it is failing (a 503 with the failed
checks in the body is ideal); a non-JSON body is reported as
`returned HTTP <status> <statusText> (non-JSON): <snippet>`, which is what a
platform error page (cold-start failure, DB down) looks like.

A project with no such endpoint can still be watched frontend-only — see the
second entry in [`config.example.jsonc`](config.example.jsonc).

## The config model

Non-secret target config lives in `vars.TARGETS` in `wrangler.jsonc` (committed).
Secrets never do: each target names a **Worker secret** that holds its health
key, and vitals resolves it from the environment at runtime.

```jsonc
"vars": {
  "TARGETS": [
    {
      "name": "myapp-api",                      // [tag] on alerts + KV state key
      "api_url": "https://api.example.com",
      "expected": "auth=on,storage=on,tls=off", // config-drift tripwire
      "web_targets": "https://app.example.com", // frontends to GET-probe
      "client_err_threshold": "3",              // 0/omitted = disabled
      "health_key_secret": "HEALTH_KEY_MYAPP"   // NAME of the secret, not the key
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | ✔ | Stable, unique project identity. Becomes the `[name]` alert tag and the KV key `last-signature:<name>`. |
| `api_url` | ✔ | Base URL, no trailing slash. `health_path` is appended. |
| `expected` | | `feature=state` pairs. Every one must be present in the audit and match, else it alerts. Omit to skip. |
| `web_targets` | | Comma-separated string or array of URLs. Only `>=400` or a fetch error counts as down (a 3xx means the origin is alive). |
| `client_err_threshold` | | Alert at this many new signatures in 15 min. `0`/omitted disables. |
| `health_key_secret` | | Name of the Worker secret sent as `X-Health-Key`. Omit if the endpoint is ungated. |
| `health_path` | | Default `/healthz/deep`. |
| `timeout_ms` | | Default `15000`. |

`TARGETS` also accepts a JSON **string** (`"TARGETS": "[{\"name\": …}]"`) if you
would rather inject the whole list from CI.

See [`config.example.jsonc`](config.example.jsonc) for the fully commented shape.

## Setup

Requires Node 20+ and a Cloudflare account.

```sh
git clone https://github.com/leansii/vitals.git && cd vitals
npm install
```

1. **Create the KV namespace** that holds the alert state and put its id in
   `wrangler.jsonc` under `kv_namespaces[0].id`:

   ```sh
   npx wrangler kv namespace create HEALTH_STATE
   ```

   The binding name must stay `STATE`. Drop the whole `kv_namespaces` block to
   run stateless — vitals then alerts on *every* failing tick.

2. **Set the global secrets:**

   ```sh
   npx wrangler secret put TELEGRAM_BOT_TOKEN   # from @BotFather
   npx wrangler secret put TELEGRAM_CHAT_ID     # message the bot, then read chat.id from
                                                # https://api.telegram.org/bot<token>/getUpdates
   npx wrangler secret put MANUAL_PROBE_KEY     # optional, gates the on-demand probe
   ```

3. **Edit `vars.TARGETS`** in `wrangler.jsonc` and set one health-key secret per
   target:

   ```sh
   npx wrangler secret put HEALTH_KEY_MYAPP     # same value as your backend's health key
   ```

4. **Deploy:**

   ```sh
   npx wrangler deploy
   ```

That is it — the `*/15 * * * *` cron starts probing.

## Adding a project

One config entry plus one secret. No code change.

```sh
# 1. append a target object to vars.TARGETS in wrangler.jsonc
# 2. store its health key under the name you referenced
npx wrangler secret put HEALTH_KEY_NEWAPP
# 3. ship it
npx wrangler deploy
```

## Manual probe

The `fetch` handler probes on demand, gated by `MANUAL_PROBE_KEY`. If that secret
is unset the handler is disabled and returns 404 to everyone.

```sh
curl -H "X-Health-Key: $MANUAL_PROBE_KEY" https://vitals.example.com
curl -H "X-Health-Key: $MANUAL_PROBE_KEY" "https://vitals.example.com/?target=myapp-api"
```

The worker answers on its `workers.dev` subdomain out of the box; the `routes`
block in `wrangler.jsonc` optionally binds a custom domain (the zone must be on
the same Cloudflare account). Remove that block if you don't need one.

It returns the per-target problems as JSON, and sends the same Telegram alerts
the cron would (it runs the identical code path, KV state included).

## Why every 15 minutes

`*/5` keeps a serverless Postgres (Neon and friends) awake around the clock,
because the DB ping inside the deep check is enough to block autosuspend — that
alone can dominate a free-tier CU-hour budget. `*/15` lets the compute suspend
between probes. The trade-off is up to 15 minutes of detection latency. The
client-error spike check reads a 15-minute window on the backend side, so it
stays correct at this interval. Change `triggers.crons` if your backend has no
such cost.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run dev         # local worker; put local secrets in .dev.vars (gitignored)
npm run tail        # live logs from the deployed worker
```

Secret hygiene: `wrangler.jsonc` and `config.example.jsonc` are committed and
must never hold a key, token or chat id — only the *names* of secrets. `.dev.vars`
is gitignored.

## License

MIT — see [LICENSE](LICENSE).
