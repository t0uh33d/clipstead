#!/bin/bash
# End-to-end test of the real app (debug build) against a running server, using the real system clipboard.
#
#   cd worker && npm run dev        # in another terminal, with an account created
#   CLIPSTEAD_TEST_USERNAME=admin CLIPSTEAD_TEST_PASSWORD='…' ./scripts/e2e.sh
#
# The app pairs itself (debug-only -E2EPairingCode hook), this script approves it like a browser would, then copies
# text and checks what reached the server. Your clipboard's text is restored afterwards.
set -u
cd "$(dirname "$0")/.."
S="${CLIPSTEAD_TEST_SERVER:-http://localhost:8787}"
USERNAME="${CLIPSTEAD_TEST_USERNAME:?set CLIPSTEAD_TEST_USERNAME}"
PASSWORD="${CLIPSTEAD_TEST_PASSWORD:?set CLIPSTEAD_TEST_PASSWORD}"
TMP=$(mktemp -d)
APP_PID=""

swift build >/dev/null || exit 1
BIN="$(swift build --show-bin-path)/Clipstead"
pbpaste > "$TMP/clipboard" 2>/dev/null

cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  defaults delete Clipstead >/dev/null 2>&1
  pbcopy < "$TMP/clipboard"
  rm -rf "$TMP"
}
trap cleanup EXIT

web() { curl -s -b "$TMP/cookies" -c "$TMP/cookies" -H "Origin: $S" -H 'content-type: application/json' -X "$1" "$S/api/v1/$2" ${3:+-d "$3"}; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
found() { web GET "clipboard?q=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")" | field 'len(d["entries"])'; }
FAILED=0
check() {
  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 (got $2, expected $3)"; FAILED=1; fi
}
copy_concealed() {
  osascript -l JavaScript -e "ObjC.import('AppKit'); const pb = \$.NSPasteboard.generalPasteboard; pb.clearContents;
    pb.declareTypesOwner(\$(['public.utf8-plain-text', 'org.nspasteboard.ConcealedType']), null);
    pb.setStringForType(\$('$1'), 'public.utf8-plain-text'); pb.setStringForType(\$(''), 'org.nspasteboard.ConcealedType'); ''" >/dev/null
}

web POST auth/login "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | grep -q '"user"' || { echo "Sign-in failed"; exit 1; }
PAIRING=$(web POST pairings)
PAIRING_ID=$(echo "$PAIRING" | field 'd["pairing"]["id"]')
CODE=$(echo "$PAIRING" | field 'd["pairing"]["code"]')
RUN=$RANDOM$RANDOM

printf 'e2e on clipboard before launch %s' "$RUN" | pbcopy
"$BIN" -E2EPairingCode "$CODE" -server "$S" -pollInterval 0.5 >/dev/null 2>&1 &
APP_PID=$!

status() { web GET "pairings/$PAIRING_ID" | field 'd["pairing"]["status"]'; }
for _ in $(seq 1 30); do [ "$(status)" = claimed ] && break; sleep 0.5; done
check "the app claims the pairing code" "$(status)" claimed
web POST "pairings/$PAIRING_ID/approve" >/dev/null
for _ in $(seq 1 30); do [ "$(status)" = completed ] && break; sleep 0.5; done
check "the app collects its credential after approval" "$(status)" completed
sleep 2

printf 'e2e copied %s' "$RUN" | pbcopy
sleep 2
check "copied text is uploaded" "$(found "e2e copied $RUN")" 1
check "text already on the clipboard at launch is not uploaded" "$(found "e2e on clipboard before launch $RUN")" 0

copy_concealed "e2e concealed $RUN"
sleep 2
check "text marked concealed (password managers) is not uploaded" "$(found "e2e concealed $RUN")" 0

printf '  \n ' | pbcopy
sleep 1.5
printf 'e2e copied %s' "$RUN" | pbcopy
sleep 2
check "copying the same text again does not duplicate it" "$(found "e2e copied $RUN")" 1

DEVICE_ID=$(web GET devices | field '[x["id"] for x in d["devices"]][0]')
web DELETE "devices/$DEVICE_ID" >/dev/null
printf 'e2e after revoke %s' "$RUN" | pbcopy
sleep 3
check "nothing is accepted after the device is revoked" "$(found "e2e after revoke $RUN")" 0
security find-generic-password -s "Clipstead device token (debug build)" -a "$S" >/dev/null 2>&1 && KEPT=yes || KEPT=no
check "the app deletes its revoked credential from the Keychain" "$KEPT" no
check "the app stops syncing after revocation" "$(defaults read Clipstead wasSyncing 2>/dev/null)" 0
check "the app keeps running" "$(kill -0 "$APP_PID" 2>/dev/null && echo yes || echo no)" yes

exit $FAILED
