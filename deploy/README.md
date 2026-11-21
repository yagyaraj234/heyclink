# Deploy (Lightsail, Ubuntu 24.04)

One box: Caddy terminates HTTPS on :443 and proxies to Node on :3000. Node serves the API and `web/dist` from the same origin, so CORS doesn't matter.

**One command** (after step 1, from your machine with SSH access): `set -a; . ./.env; set +a; deploy/setup.sh <static-ip>` does steps 2–6 and is safe to rerun. `deploy/setup.sh <static-ip> redeploy` pulls main, rebuilds web and restarts. The manual steps below are what it runs.

1. **Instance.** Create an Ubuntu 24.04 instance with at least 1 GB RAM and attach a static IP. Open TCP **80 and 443** under Networking → IPv4 firewall (443 is closed by default, and Caddy's certificate challenge needs 80). Point your hostname's A record at the static IP, or use `<ip-with-dashes>.sslip.io`.

2. **Node 26 and pnpm.**
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo npm i -g pnpm@11.23.0
   node -v   # v26.x; the unit uses /usr/bin/node
   ```

3. **App.**
   ```sh
   sudo useradd --system --home /opt/vfi --shell /usr/sbin/nologin vfi
   sudo git clone https://github.com/yagyaraj234/voice-for-india /opt/vfi
   cd /opt/vfi
   sudo pnpm install --frozen-lockfile --filter . --filter voice-for-india-web   # server + web; skips mobile/
   sudo pnpm --filter voice-for-india-web build   # → web/dist, served by Node
   sudo chown -R vfi:vfi /opt/vfi
   ```

4. **Secrets** in `/etc/vfi.env`:
   ```sh
   OPENAI_API_KEY=...
   SARVAM_API_KEY=...
   STT_PROVIDER=sarvam   # sarvam | openai | whisper-cpp
   PORT=3000
   DATABASE_URL=postgres://...   # Neon pooled connection string (-pooler host), sslmode=require
   # PG_POOL_MAX=5             connections per instance
   # OPENAI_LLM_MODEL=...      optional override
   # WHISPER_CLI=/usr/local/bin/whisper-cli   only for whisper-cpp
   # WHISPER_MODEL=/opt/models/ggml-large-v3-turbo-q5_0.bin
   ```
   ```sh
   sudo chown root:vfi /etc/vfi.env && sudo chmod 640 /etc/vfi.env
   ```

5. **Service.**
   ```sh
   sudo cp deploy/vfi.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now vfi
   curl -s localhost:3000/health   # {"ok":true,"stt":"sarvam","llm":"..."}
   ```

6. **Caddy.**
   ```sh
   sudo apt-get install -y caddy
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # then edit the hostname
   sudo systemctl reload caddy
   curl -s https://<host>/health
   ```

**Update:** `cd /opt/vfi && sudo -u vfi git pull && sudo -u vfi pnpm install --frozen-lockfile --filter . --filter voice-for-india-web && sudo -u vfi pnpm --filter voice-for-india-web build && sudo systemctl restart vfi`.
**Logs:** `journalctl -u vfi -f`, `journalctl -u caddy -f`.

**whisper-cpp (optional, offline STT).** Build whisper.cpp (`cmake -B build && cmake --build build -j`), copy `build/bin/whisper-cli` to `/usr/local/bin`, and download a ggml model. A 1 GB instance is too small for large-v3-turbo, so use a smaller model or a bigger box. whisper-cli may not read browser webm unless it was built with ffmpeg. Sarvam and OpenAI both accept webm directly.

Households, calls, approved quantities, delivery records and reminders live in Postgres at `DATABASE_URL` (Neon). The instance keeps no data, so it can be deleted or scaled out. The server creates its tables on startup.

### Grocery pilot

Start the local API with `pnpm dev` and the mobile app with `pnpm --dir mobile start`. Sign up a household and use its join code on the cook phone. The demo household supports simulated orders. With the provider disabled, a new household can review a cart, open individual store links, and mark what it bought and received.

For an approved Swiggy staging integration, set `INSTAMART_PUBLIC_ORIGIN` to the API's public HTTPS origin, register the exact OAuth callback `/instamart/callback` on that origin, and set `INSTAMART_STAGING=1`. Supply `INSTAMART_CLIENT_ID` if issued. The owner signs into Swiggy in their browser. Staging finishes on a review screen. Production hands off to the same account's Instamart storefront for final confirmation and payment.

The household cap includes existing packs of the requested groceries. Other items already in the owner’s Instamart cart stay on the retailer bill. After a provider timeout, reopen the same grocery request to check the retailer cart. A matching cart can continue without adding packs twice. The owner confirms what they bought, and the cook’s delivery receipt lists only the packs added for this request. When using store links, edit the household list to match the purchase.

For locked-phone alerts, use an Expo development or standalone build linked to the household app's EAS project, configure APNs or FCM credentials, and tap **Enable grocery alerts** on the owner phone. The app reads the project ID from EAS config or `EXPO_PUBLIC_EAS_PROJECT_ID`. A project using enhanced push security also needs `EXPO_ACCESS_TOKEN` on the server. The scheduler checks pending alerts every minute.
