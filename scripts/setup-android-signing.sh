#!/usr/bin/env bash
# One-time Android release signing setup for Vikaspogu/t3code.
# Run this yourself in a terminal:  bash ~/setup-android-signing.sh
# It generates a release keystore, stores it in GitHub Actions secrets,
# and writes a local backup you must move into your password manager.
set -euo pipefail
umask 077 # keystore material must never be world-readable, even briefly

BACKUP_DIR="$HOME/orbit-android-release-backup"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" # a pre-existing dir may carry a looser mode
cd "$BACKUP_DIR"

# Never silently rotate the release key: APKs signed with the old key could no
# longer auto-update. Abort if a keystore already exists; rotating requires an
# explicit, informed cleanup.
if [[ -f orbit-release.jks ]]; then
  echo "A keystore already exists at $BACKUP_DIR/orbit-release.jks" >&2
  echo "If you really want to rotate the key, back it up, then delete $BACKUP_DIR and re-run." >&2
  exit 1
fi
rm -f keystore.b64 credentials.txt

STORE_PW="$(openssl rand -hex 24)"

keytool -genkeypair -v \
  -keystore orbit-release.jks \
  -alias orbit-release \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass env:STORE_PW -keypass env:STORE_PW \
  -dname "CN=Orbit Mobile, O=Vikaspogu, C=US"

# Portable single-line base64 (GNU wraps at 76 cols, BSD has no -w flag).
base64 < orbit-release.jks | tr -d '\n' > keystore.b64
trap 'rm -f keystore.b64' EXIT # clean up even when a gh secret set fails

gh secret set ORBIT_ANDROID_KEYSTORE_B64 --repo Vikaspogu/t3code < keystore.b64
printf %s "$STORE_PW" | gh secret set ORBIT_ANDROID_KEYSTORE_PASSWORD --repo Vikaspogu/t3code
printf %s "$STORE_PW" | gh secret set ORBIT_ANDROID_KEY_PASSWORD --repo Vikaspogu/t3code
gh secret set ORBIT_ANDROID_KEY_ALIAS --repo Vikaspogu/t3code --body "orbit-release"

rm keystore.b64
printf 'alias: orbit-release\nstore password (= key password): %s\n' "$STORE_PW" > credentials.txt
chmod 600 credentials.txt orbit-release.jks

echo
echo "Done. Secrets are in GitHub. BACKUP the keystore now:"
echo "  1. Save $BACKUP_DIR/orbit-release.jks and credentials.txt into your password manager."
echo "  2. Then you may delete $BACKUP_DIR."
echo "If you lose the keystore, existing installs can never auto-update again."
