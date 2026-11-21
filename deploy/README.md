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

State is in memory: a restart clears calls and approvals and resets the household to `fixtures/household.json`.
