# SparkBench feedback relay

A tiny Node service (no dependencies) that receives bug reports and ideas from the SparkBench app and files them as
GitHub issues on `kingrebelf/Spark-bench`, labeled `feedback`, `bug` or `idea`, and `from-app`. The app can't hold a
GitHub token itself (anyone could extract it), so the token lives here.

Until a relay is deployed, the app opens a prefilled GitHub "new issue" page in the browser instead, so reports still
reach GitHub issues (the reporter needs a GitHub account).

## What it does
- `POST /feedback` (JSON, at most 128 KB): validates the report, keeps only known fields, and creates the issue. It
  answers `201 {"issueUrl": ...}` on success, `400` or `413` when the report is refused for good, and `429` or `502`
  when the report should be retried later (the app queues it and retries with backoff).
- `GET /health`: returns `{"ok":true}`.
- **Rate limits** (in memory): 5 reports per IP per 10 minutes, and 60 issues per hour in total.
- **Honeypot**: the app's form has a hidden `website` field. When it's filled in, the relay answers 202 and files nothing.
- User text is "defanged" so a report can't @-mention people or link other issues. Simulation logs and the project
  go in collapsed `<details>` blocks.
- If GitHub refuses the labels, the relay files the issue without them.

## Configuration (environment)
| Variable | Default | |
|---|---|---|
| `GITHUB_TOKEN` | required | Fine-grained PAT (see below) |
| `GITHUB_REPO` | `kingrebelf/Spark-bench` | |
| `PORT` | `8787` | |
| `TRUST_PROXY` | off | Set to `1` only behind a reverse proxy that sets `X-Forwarded-For`. Without it, every client looks like the proxy and shares one rate limit. |
| `RATE_PER_IP`, `RATE_PER_IP_WINDOW_MIN` | `5`, `10` | |
| `RATE_GLOBAL_PER_HOUR` | `60` | |
| `MAX_BODY_KB` | `128` | |

### The token
Use a fine-grained personal access token that can do nothing except write issues on this one repository:
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. Resource owner: `kingrebelf`. Repository access: **Only select repositories** → `Spark-bench`.
3. Permissions → Repository permissions → **Issues: Read and write**. Leave everything else at "No access"
   (Metadata: Read-only is added automatically).
4. Choose an expiry (e.g. 1 year) and put a reminder in your calendar to rotate it.

Create the labels once so they get colours (GitHub → Issues → Labels): `feedback`, `bug` (exists by default),
`idea`, `from-app`.

## Run locally
```bash
cd relay
GITHUB_TOKEN=github_pat_xxx node server.ts      # Node 22.6+ (type stripping; on by default from 23.6)
```
Point a packaged SparkBench at it without rebuilding:
```bash
SPARKBENCH_FEEDBACK_RELAY=http://127.0.0.1:8787/feedback "release/win-unpacked/SparkBench.exe"
```
Tests: `npm test` in the repository root runs `tests/launcher-relay.test.ts` (validation, rate limiting, honeypot,
size limits, GitHub errors) against a real HTTP server with a fake GitHub.

## Deploy (not done yet: needs your approval)
Any host that runs a Docker container over HTTPS works. Two concrete options:

### A. Your DigitalOcean droplet (autbot-droplet), behind nginx, at `https://feedback.autbot.ca`
1. DNS: add an `A` record `feedback.autbot.ca` → `157.230.236.204`.
2. Copy the folder and start the container (bound to localhost only):
   ```bash
   scp -r relay root@157.230.236.204:/opt/sparkbench-relay
   ssh root@157.230.236.204
   cd /opt/sparkbench-relay
   cp .env.example .env && nano .env            # paste the token; keep TRUST_PROXY=1
   chmod 600 .env
   docker build -t sparkbench-relay .
   docker run -d --name sparkbench-relay --restart unless-stopped --env-file .env -p 127.0.0.1:8787:8787 sparkbench-relay
   curl -s http://127.0.0.1:8787/health
   ```
3. nginx site `/etc/nginx/sites-available/feedback.autbot.ca`:
   ```nginx
   server {
     server_name feedback.autbot.ca;
     client_max_body_size 256k;
     location / {
       proxy_pass http://127.0.0.1:8787;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header Host $host;
     }
     listen 80;
   }
   ```
   Then `ln -s /etc/nginx/sites-available/feedback.autbot.ca /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`
   and `certbot --nginx -d feedback.autbot.ca` for HTTPS. (`$remote_addr`, not `$proxy_add_x_forwarded_for`, so
   clients can't spoof their IP past the rate limit.)
4. Check it: `curl -s https://feedback.autbot.ca/health`.

### B. A container platform (Fly.io, Render, Railway, Cloud Run)
Deploy this folder with its Dockerfile, set `GITHUB_TOKEN` as a secret and `TRUST_PROXY=1`, and expose port 8787.
Run a single instance: the rate limits are kept in memory.

### Then switch the app over
Set `FEEDBACK_RELAY_URL` in `src/launcher/config.ts` to the HTTPS URL (e.g. `https://feedback.autbot.ca/feedback`)
and release a new version. Builds without it keep using the browser fallback. Only `https:` URLs are accepted (plus
`http://localhost` for testing).

## Updating and operating
- Logs: `docker logs sparkbench-relay` (one line per issue created, honeypot hit, or GitHub error; report text isn't logged).
- New version: copy the files, `docker build`, then `docker rm -f sparkbench-relay` and the same `docker run`.
- Rotate the token: create a new one, edit `.env`, recreate the container, and delete the old token on GitHub.
