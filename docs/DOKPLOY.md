# Deploy thepinata.fun on Dokploy (zero-downtime updates)

The app is one Docker image (the [`Dockerfile`](../Dockerfile) at the repo root): a Node server that serves the site, the API and the websocket, and runs the payout bot. Its data is a SQLite file on a Docker volume.

| Dokploy piece | What it is | Holds |
|---|---|---|
| **Application** `pinata` | This repository, built from the `Dockerfile` and run as a Docker Swarm service. Traefik sends `thepinata.fun` to it on port 3000. | The prize wallet key, at runtime only |
| **Volume** `pinata-data` → `/app/data` | The database and the hand-over lock | Rounds, trades, payout steps |

## Why an Application and not a Compose service

A Compose service is stopped and then started again on every deploy, so the site is down for the restart. A Dokploy **Application** runs as a Swarm service, and Swarm can start the new version first and stop the old one only once the new one is healthy. The settings below turn that on.

### What happens on an update

1. **Build.** Dokploy builds the new image while the old version keeps serving. If the build fails, nothing changes.
2. **Standby.** The new container starts and answers `/api/health` as `"state": "standby"`. Only one server may run the game and the payouts, so it waits for the lock file on the shared volume. Standby counts as healthy.
3. **Hand-over.** Swarm stops the old container. It stops taking trades, lets the payout step in flight finish (6 seconds at most), closes the database and releases the lock. The standby takes over within a quarter of a second.
4. **Open pages keep working.** Their websocket reconnects by itself in under a second and the piñata carries on from the same HP.
5. **Rollback.** If the new version does not become healthy within a minute, Swarm puts the previous one back.

Payouts are safe across the hand-over. Every transaction is saved, signed, before it is sent, and the new server resumes anything in flight from the database. If the old server dies without releasing the lock, the new one takes over after 8 seconds.

## Set up

1. **Application.**
   - In your Dokploy project choose **Create Service → Application** and name it `pinata`.
   - In **General**, set the provider to GitHub (`haiderlikesrust/pinata`, branch `main`). A Git URL with a deploy key also works.
   - Set **Build Type** to **Dockerfile**, **Dockerfile Path** to `Dockerfile` and **Docker Context Path** to `.`.
2. **Environment.**
   - Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example) and set `ADMIN_TOKEN`.
   - For the first deploy keep `MODE=dry`. That is a public demo with simulated trades.
   - Add the wallet key only when you go live. It is a runtime variable; never put it in **Build-time Arguments**.
3. **Domain.**
   - In **Domains**, add `thepinata.fun` with path `/`, container port **3000**, and HTTPS with Let's Encrypt.
   - Point the domain's DNS at the server first: an `A` record for `thepinata.fun` (and `www`) to the VPS address. The certificate cannot be issued until DNS resolves.
   - For `www.thepinata.fun`, add it the same way, then a "www to non-www" redirect under **Advanced → Redirects**.
4. **Zero-downtime settings.** In **Advanced → Cluster Settings**:
   - **Replicas:** leave it at `1`. Only one server can run the game; a second would only wait in standby.
   - **Swarm Settings → Update Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "rollback", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Swarm Settings → Rollback Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "pause", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Health Check** (the same check that is built into the image; paste it anyway so an update never starts without one):
     ```json
     { "Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], "Interval": 5000000000, "Timeout": 3000000000, "StartPeriod": 40000000000, "Retries": 3 }
     ```
   - Durations in these fields are in nanoseconds (5000000000 = 5 s).
   - Newer Dokploy versions show these as a form instead of JSON (**Swarm Settings → Health Check / Update Config**). Enter the same values: the test as two commands (`CMD-SHELL`, then the `node -e "…"` line), failure action **Rollback**, order **Start First**.
5. **Data volume.** In **Advanced → Volumes**, add a **Volume Mount** with volume name `pinata-data` and mount path `/app/data`. Without it every deploy would start from an empty database, and the old and new servers could not hand over.
6. **Deploy.** Click **Deploy** and follow the build log. Then open `https://thepinata.fun/api/health`. It should show `"ok": true`, `"state": "active"` and `"mode": "dry"`.
7. **Optional:** turn on **Autodeploy** so every push to `main` deploys the same way.

## Check an update yourself

Leave this running while you click **Deploy**. It should print only `200`:

```bash
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://thepinata.fun/api/health; sleep 0.5; done
```

The new container's log shows `standby: waiting for the running server to hand over`, then `active`.

`https://thepinata.fun/api/handover` shows how each recent hand-over went. A healthy one reads: the new server `started` and went `standby`, a few seconds later the old one logged `stopping` and `released`, and the new one went `active` with `"how": "handed over"` within about a tenth of a second. `"how": "expired"` means the old server died without letting go and the new one took over after 8 seconds.

Measured on the live site: 110 of 110 requests to `/api/state` returned 200 across a redeploy, and the hand-over took about 60 ms.

## Go live

1. Launch the coin from a fresh wallet. Set `MINT`, `X_URL`, `QUOTE_MINT` (for a coin quoted in $CARDS), `RPC_URL`, `JUPITER_API_KEY`, `TREASURY_SECRET_KEY`, and optionally `PUMPPORTAL_API_KEY`.
2. Send the prize wallet about 0.2 SOL. Fees arrive in $CARDS and the pool is USDC, so nothing tops up SOL for you: it only pays network fees, and payouts stall if it runs out.
3. Set `MODE=live` and redeploy. Keep `MAX_HP_USD` low and `MIN_POT_USD` around 60 for the first round, and watch the application's log.
4. The rest of the launch checklist is in the [README](../README.md#going-live).

## Rules that keep updates seamless

- **Keep one replica.**
- **Never remove the `pinata-data` volume** and never point a second app at it.
- **Database changes must be additive** (new tables and columns). After a rollback the previous version runs against the new schema.
- **Changing settings needs a redeploy**, which goes through the same hand-over.

## Local check of the image

```sh
docker build -t pinata .
docker volume create pinata-test
docker run --rm -p 3000:3000 -v pinata-test:/app/data pinata
```

Start a second container on another port with the same volume to watch the hand-over: it logs `standby`, and becomes `active` when you stop the first.

Reference: [Dokploy zero downtime](https://docs.dokploy.com/docs/core/applications/zero-downtime), [Dokploy advanced settings](https://docs.dokploy.com/docs/core/applications/advanced).
