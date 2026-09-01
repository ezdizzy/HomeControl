#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
#
# HomeControl installer: downloads the latest release from GitHub and
# installs the package (apk on OpenWrt 25.x, ipk on 23.05/24.10) plus the
# Russian translation.
#
# Usage:
#   sh install.sh                # install latest release
#   sh install.sh v0.2.0         # install a specific version/tag
#
# After install: LuCI -> Services -> HomeControl (login as root).

set -e

REPO="ezdizzy/HomeControl"
TAG="${1:-latest}"
API="https://api.github.com/repos/$REPO/releases"
TMPDIR_DL="/tmp/homecontrol-install"
mkdir -p "$TMPDIR_DL"

log() { echo "[install] $*"; }

# ── detect package manager ──────────────────────────────────────────────
if command -v apk >/dev/null 2>&1; then
	PKG="apk"; EXT="apk"
elif command -v opkg >/dev/null 2>&1; then
	PKG="opkg"; EXT="ipk"
else
	log "ERROR: neither apk nor opkg found — is this OpenWrt?"
	exit 1
fi
log "package manager: $PKG"

# ── resolve the release to install ──────────────────────────────────────
if [ "$TAG" = "latest" ]; then
	REL_URL="https://api.github.com/repos/$REPO/releases/latest"
else
	REL_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

log "fetching release info: $REL_URL"
REL_JSON="$(wget -qO- --timeout=30 "$REL_URL" 2>/dev/null || true)"
if [ -z "$REL_JSON" ]; then
	log "ERROR: could not fetch release info (check internet access)"
	exit 1
fi

TAG_NAME="$(printf '%s\n' "$REL_JSON" | grep -m1 '"tag_name"' | sed 's/.*: "\(.*\)",*/\1/')"
[ -n "$TAG_NAME" ] || { log "ERROR: no tag_name in release data"; exit 1; }
log "release: $TAG_NAME"

# ── pick download URLs ──────────────────────────────────────────────────
# main app package: luci-app-homecontrol_<ver>_all.<ext>
PKG_URL="$(printf '%s\n' "$REL_JSON" | grep -o '"browser_download_url": *"[^"]*"' \
	| grep "luci-app-homecontrol_" | grep "_all\.$EXT\"" \
	| head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')"
# i18n ru package (optional)
I18N_URL="$(printf '%s\n' "$REL_JSON" | grep -o '"browser_download_url": *"[^"]*"' \
	| grep "luci-i18n-homecontrol-ru_" | grep "_all\.$EXT\"" \
	| head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')"

[ -n "$PKG_URL" ] || { log "ERROR: no .$EXT asset in release"; exit 1; }

# ── download ────────────────────────────────────────────────────────────
PKG_FILE="$TMPDIR_DL/luci-app-homecontrol.$EXT"
log "downloading $(basename "$PKG_URL")"
wget -qO "$PKG_FILE" --timeout=60 "$PKG_URL"
[ -s "$PKG_FILE" ] || { log "ERROR: download failed"; exit 1; }

I18N_FILE=""
if [ -n "$I18N_URL" ]; then
	I18N_FILE="$TMPDIR_DL/luci-i18n-homecontrol-ru.$EXT"
	log "downloading $(basename "$I18N_URL")"
	wget -qO "$I18N_FILE" --timeout=60 "$I18N_URL" || true
fi

# ── install ─────────────────────────────────────────────────────────────
log "installing main package…"
if [ "$PKG" = "apk" ]; then
	apk add --allow-untrusted "$PKG_FILE"
	[ -n "$I18N_FILE" ] && [ -s "$I18N_FILE" ] && apk add --allow-untrusted "$I18N_FILE" || true
else
	opkg install "$PKG_FILE" || opkg install --force-depends "$PKG_FILE"
	[ -n "$I18N_FILE" ] && [ -s "$I18N_FILE" ] && opkg install "$I18N_FILE" || true
fi

# ── activate ────────────────────────────────────────────────────────────
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
/etc/init.d/homecontrol enable 2>/dev/null || true
/etc/init.d/homecontrol restart 2>/dev/null >/dev/null || /etc/init.d/homecontrol start 2>/dev/null

rm -rf "$TMPDIR_DL"
log "done. Open LuCI -> Services -> HomeControl."
