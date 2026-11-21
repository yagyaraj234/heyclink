#!/usr/bin/env bash
# One-command deploy of README steps 2-6 to a fresh Ubuntu 24.04 box, run from the operator's machine.
#   OPENAI_API_KEY=... SARVAM_API_KEY=... deploy/setup.sh [user@]HOST            full setup (idempotent; rerun any time)
#   deploy/setup.sh [user@]HOST redeploy                                          git pull, build web, restart
# HOST is the box's IP or hostname; the user defaults to ubuntu. Caddy serves VFI_DOMAIN, else HOST, else
# <ip-with-dashes>.sslip.io for a bare IP. Optional env: STT_PROVIDER (sarvam), OPENAI_LLM_MODEL.
# Keys come from your env (e.g. `set -a; . ./.env; set +a`) and travel inside the script on ssh stdin, so they
# never reach argv, `ps` or the terminal. SSH auth is yours: ssh-agent or ~/.ssh/config (ssh-add the Lightsail .pem).
set -euo pipefail

host=${1:?usage: deploy/setup.sh [user@]HOST [redeploy]}
mode=${2:-setup}
[[ $mode == setup || $mode == redeploy ]] || { echo "mode must be setup or redeploy" >&2; exit 2; }
target=$host; [[ $host == *@* ]] || target="ubuntu@$host"
h=${host#*@}
if [[ $h =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then domain=${VFI_DOMAIN:-${h//./-}.sslip.io}; else domain=${VFI_DOMAIN:-$h}; fi

envb64=""
if [[ $mode == setup ]]; then
  stt=${STT_PROVIDER:-sarvam}
  : "${OPENAI_API_KEY:?OPENAI_API_KEY must be set in your env (the LLM always needs it)}"
  [[ $stt != sarvam ]] || : "${SARVAM_API_KEY:?SARVAM_API_KEY must be set in your env for STT_PROVIDER=sarvam}"
  envb64=$({
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
    [[ -z ${SARVAM_API_KEY:-} ]] || printf 'SARVAM_API_KEY=%s\n' "$SARVAM_API_KEY"
    printf 'STT_PROVIDER=%s\nPORT=3000\n' "$stt"
    [[ -z ${OPENAI_LLM_MODEL:-} ]] || printf 'OPENAI_LLM_MODEL=%s\n' "$OPENAI_LLM_MODEL"
  } | base64 | tr -d '\n')
fi

echo "==> $mode $target (https://$domain)"
{
  printf 'MODE=%q DOMAIN=%q ENVB64=%q\n' "$mode" "$domain" "$envb64"
  cat <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/vfi
git_() { git -c safe.directory="$APP" -C "$APP" "$@"; }
build() {
  cd "$APP"
  pnpm install --prod --frozen-lockfile
  pnpm --dir web install --frozen-lockfile && pnpm --dir web build
  chown -R vfi:vfi "$APP"
}
health() { # wait for the restarted service; prints the body, never the env
  for _ in $(seq 30); do curl -fsS localhost:3000/health && echo && return 0; sleep 1; done
  journalctl -u vfi -n 30 --no-pager; return 1
}

if [[ $MODE == redeploy ]]; then
  git_ pull --ff-only
  build
  systemctl restart vfi
  health
  exit 0
fi

# 2. Node 26, git, caddy, pnpm (each skipped when already at the wanted version)
[[ $(node -v 2>/dev/null) == v26.* ]] || { curl -fsSL https://deb.nodesource.com/setup_26.x | bash -; apt-get install -y nodejs; }
apt-get install -y git caddy
[[ $(pnpm -v 2>/dev/null) == 11.23.0 ]] || npm i -g pnpm@11.23.0

# 3. App
id vfi >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin vfi
if [[ -d $APP/.git ]]; then git_ pull --ff-only; else git clone https://github.com/yagyaraj234/voice-for-india "$APP"; fi
build

# 4. Secrets: written from stdin, never echoed; root:vfi 640 because node (User=vfi) reads it
printf '%s' "$ENVB64" | base64 -d | install -m 640 -o root -g vfi /dev/stdin /etc/vfi.env

# 5. Service (restart, not just enable --now, so a rerun picks up new code and env)
install -m 644 "$APP/deploy/vfi.service" /etc/systemd/system/vfi.service
systemctl daemon-reload
systemctl enable vfi
systemctl restart vfi
health

# 6. Caddy with this box's hostname
sed "s/vfi\.example\.com/$DOMAIN/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy
REMOTE
} | ssh -o StrictHostKeyChecking=accept-new "$target" 'sudo bash -s'

# From outside: proves DNS, the Lightsail firewall (80/443) and the certificate. First issuance takes a few seconds.
for _ in $(seq 20); do
  if body=$(curl -fsS -m 5 "https://$domain/health" 2>/dev/null); then echo "==> https://$domain/health $body"; exit 0; fi
  sleep 3
done
echo "==> https://$domain/health unreachable: check the A record and that TCP 80+443 are open in the Lightsail firewall" >&2
exit 1
