#!/bin/sh
# Give the live Graphu server an Anthropic key (or take it away), then restart Graphu.
#
#   deploy/set-key.sh
#
# You paste the key at a hidden prompt. It goes straight to the server over SSH and is
# stored in ~/graphu/deploy/.env there. Press Enter with nothing typed to remove the key.
#
# With a key set, anyone with the link can spend it. Set a monthly limit in the Claude
# Console first.
set -eu

SERVER="${GRAPHU_SERVER:-ubuntu@3.12.190.201}"
KEY_FILE="${GRAPHU_SSH_KEY:-$HOME/.ssh/graphu-key.pem}"

printf 'Paste your Anthropic key (it will not be shown), then press Enter: '
stty -echo
read -r KEY
stty echo
echo

# The key travels on standard input, so it never appears in a command line or in history.
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | ssh -i "$KEY_FILE" "$SERVER" '
  cd ~/graphu/deploy && umask 077 &&
  grep -v "^ANTHROPIC_API_KEY=" .env > .env.new; cat >> .env.new && mv .env.new .env &&
  sudo docker compose up -d >/dev/null 2>&1 && sleep 4 &&
  sudo docker compose logs graphu 2>&1 | grep "^graphu.*AI:" | tail -1'
