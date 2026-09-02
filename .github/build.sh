#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
#
# Build luci-app-homecontrol as ipk (opkg, OpenWrt 23.05/24.10) and
# apk (OpenWrt 25.x+) without a full buildroot, using the same technique
# as luci-app-re-homeproxy: assemble the file tree and package it.
#
# Usage: bash build.sh <apk|ipk> <snapshot|release> [version]

set -o errexit
set -o pipefail

PKG_MGR="${1:-apk}"
RELEASE_TYPE="${2:-snapshot}"
PKG_VERSION_OVERRIDE="${3:-}"

export PKG_SOURCE_DATE_EPOCH="$(date '+%s')"
export SOURCE_DATE_EPOCH="$PKG_SOURCE_DATE_EPOCH"

BASE_DIR="$(cd "$(dirname "$0")"; pwd)"
PKG_DIR="$BASE_DIR/.."

function get_mk_value() {
	awk -F "$1:=" '{print $2}' "$PKG_DIR/Makefile" | xargs
}

PKG_NAME="$(get_mk_value "PKG_NAME")"
if [ "$RELEASE_TYPE" == "release" ] && [ -n "$PKG_VERSION_OVERRIDE" ]; then
	PKG_VERSION="$PKG_VERSION_OVERRIDE"
else
	PKG_VERSION="$(get_mk_value "PKG_VERSION")"
fi
if [ "$RELEASE_TYPE" == "snapshot" ]; then
	# Unique timestamp version so package managers never skip newer builds.
	# Dotted numeric (no hyphens) — valid for both apk and ipk.
	PKG_VERSION="$(date -u +%Y.%m.%d.%H%M%S)"
fi

TEMP_DIR="$(mktemp -d -p "$BASE_DIR")"
TEMP_PKG_DIR="$TEMP_DIR/$PKG_NAME"

if [ "$PKG_MGR" == "apk" ]; then
	mkdir -p "$TEMP_PKG_DIR/lib/apk/packages/"
else
	mkdir -p "$TEMP_PKG_DIR/CONTROL/"
fi

cp -fpR "$PKG_DIR/htdocs"/* "$TEMP_PKG_DIR/www/"
cp -fpR "$PKG_DIR/root"/* "$TEMP_PKG_DIR/"

# LuCI serves views from /www/luci-static/resources (luci.main.resourcebase).
# Some earlier builds landed the views in www/resources instead of
# www/luci-static/resources (checkout dir layout quirk). Normalize:
# if views ended up in www/resources, move them to the correct path.
if [ -d "$TEMP_PKG_DIR/www/resources/view" ] && [ ! -d "$TEMP_PKG_DIR/www/luci-static/resources/view" ]; then
	mkdir -p "$TEMP_PKG_DIR/www/luci-static/resources"
	mv "$TEMP_PKG_DIR/www/resources/view" "$TEMP_PKG_DIR/www/luci-static/resources/view"
	echo "NOTE: relocated view files from www/resources to www/luci-static/resources" >&2
fi

# Hard verification: views must be at the correct path, never at the wrong one.
if [ ! -f "$TEMP_PKG_DIR/www/luci-static/resources/view/homecontrol/dashboard.js" ] || [ -d "$TEMP_PKG_DIR/www/resources" ]; then
	echo "ERROR: view files not under www/luci-static/resources — check htdocs layout" >&2
	find "$TEMP_PKG_DIR/www" -maxdepth 4 >&2
	exit 1
fi

# Stamp the package version for the in-app updater (self-update feature).
mkdir -p "$TEMP_PKG_DIR/usr/share/homecontrol/"
printf '%s\n' "$PKG_VERSION" > "$TEMP_PKG_DIR/usr/share/homecontrol/version"

# Keep the user config across upgrades.
if [ "$PKG_MGR" == "apk" ]; then
	echo "/etc/config/homecontrol" > "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles"
	find "$TEMP_PKG_DIR" -type f,l -printf '/%P\n' | sort > "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.list"
else
	echo "/etc/config/homecontrol" > "$TEMP_PKG_DIR/CONTROL/conffiles"

	cat > "$TEMP_PKG_DIR/CONTROL/control" <<-EOF
		Package: $PKG_NAME
		Version: $PKG_VERSION
		Depends: libc, firewall4, ucode-mod-fs, ucode-mod-uci, ucode-mod-ubus
		Source: https://github.com/ezdizzy/HomeControl
		SourceName: $PKG_NAME
		Section: luci
		SourceDateEpoch: $PKG_SOURCE_DATE_EPOCH
		Maintainer: HomeControl contributors
		Architecture: all
		Installed-Size: TO-BE-FILLED-BY-IPKG-BUILD
		Description: Advanced parental control and network access management for OpenWrt LuCI
	EOF
	chmod 0644 "$TEMP_PKG_DIR/CONTROL/control"

	echo -e '#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
default_postinst $@
exit 0' > "$TEMP_PKG_DIR/CONTROL/postinst"
	chmod 0755 "$TEMP_PKG_DIR/CONTROL/postinst"

	echo -e '#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
default_prerm $0 $@' > "$TEMP_PKG_DIR/CONTROL/prerm"
	chmod 0755 "$TEMP_PKG_DIR/CONTROL/prerm"

	echo -e '[ -n "${IPKG_INSTROOT}" ] || {
(. /etc/uci-defaults/luci-homecontrol) && rm -f /etc/uci-defaults/luci-homecontrol
rm -f /tmp/luci-indexcache*
rm -rf /tmp/luci-modulecache/
killall -HUP rpcd 2>/dev/null
exit 0
}' > "$TEMP_PKG_DIR/CONTROL/postinst-pkg"
	chmod 0755 "$TEMP_PKG_DIR/CONTROL/postinst-pkg"

	ipkg-build -m "" "$TEMP_PKG_DIR" "$TEMP_DIR"
	mv "$TEMP_DIR/${PKG_NAME}_${PKG_VERSION}_all.ipk" "$BASE_DIR/${PKG_NAME}_${PKG_VERSION}_all.ipk"
	echo "Built: ${PKG_NAME}_${PKG_VERSION}_all.ipk"
	rm -rf "$TEMP_DIR"
	exit 0
fi

# ── apk packaging (OpenWrt 25.x) ─────────────────────────────────────────

cat > "$TEMP_DIR/post-install" <<-'EOF'
#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="PKGNAME_PLACEHOLDER"
add_group_and_user
[ -n "${IPKG_INSTROOT}" ] || { if [ -d /tmp/.uci ] || mkdir -p /tmp/.uci; then
	for i in /etc/uci-defaults/luci-homecontrol; do
		[ -f "$i" ] && ( . "$i" ) && rm -f "$i"
	done
	uci commit
fi
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}
EOF
sed -i "s/PKGNAME_PLACEHOLDER/$PKG_NAME/" "$TEMP_DIR/post-install"

cat > "$TEMP_DIR/post-upgrade" <<-'EOF'
#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="PKGNAME_PLACEHOLDER"
add_group_and_user
[ -n "${IPKG_INSTROOT}" ] || { rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}
EOF
sed -i "s/PKGNAME_PLACEHOLDER/$PKG_NAME/" "$TEMP_DIR/post-upgrade"

cat > "$TEMP_DIR/pre-deinstall" <<-'EOF'
#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="PKGNAME_PLACEHOLDER"
default_prerm
EOF
sed -i "s/PKGNAME_PLACEHOLDER/$PKG_NAME/" "$TEMP_DIR/pre-deinstall"

apk mkpkg \
	--info "name:$PKG_NAME" \
	--info "version:$PKG_VERSION" \
	--info "description:Advanced parental control and network access management for OpenWrt LuCI" \
	--info "arch:noarch" \
	--info "origin:$PKG_NAME" \
	--info "url:https://github.com/ezdizzy/HomeControl" \
	--info "maintainer:HomeControl contributors" \
	--info "depends:libc firewall4 ucode-mod-fs ucode-mod-uci ucode-mod-ubus" \
	--script "post-install:$TEMP_DIR/post-install" \
	--script "post-upgrade:$TEMP_DIR/post-upgrade" \
	--script "pre-deinstall:$TEMP_DIR/pre-deinstall" \
	--files "$TEMP_PKG_DIR" \
	--output "$TEMP_DIR/${PKG_NAME}_${PKG_VERSION}.apk"

mv "$TEMP_DIR/${PKG_NAME}_${PKG_VERSION}.apk" "$BASE_DIR/${PKG_NAME}_${PKG_VERSION}_all.apk"
echo "Built: ${PKG_NAME}_${PKG_VERSION}_all.apk"

# ── i18n: Russian translation package ────────────────────────────────────

I18N_PKG_NAME="luci-i18n-homecontrol-ru"
I18N_TEMP_DIR="$(mktemp -d -p "$BASE_DIR")"
I18N_TEMP_PKG_DIR="$I18N_TEMP_DIR/$I18N_PKG_NAME"
mkdir -p "$I18N_TEMP_PKG_DIR/usr/lib/lua/luci/i18n/"
mkdir -p "$I18N_TEMP_PKG_DIR/lib/apk/packages/"

po2lmo "$PKG_DIR/po/ru/homecontrol.po" \
	"$I18N_TEMP_PKG_DIR/usr/lib/lua/luci/i18n/homecontrol.ru.lmo"

find "$I18N_TEMP_PKG_DIR" -type f,l -printf '/%P\n' | sort > \
	"$I18N_TEMP_PKG_DIR/lib/apk/packages/$I18N_PKG_NAME.list"

apk mkpkg \
	--info "name:$I18N_PKG_NAME" \
	--info "version:$PKG_VERSION" \
	--info "description:Russian translation for luci-app-homecontrol" \
	--info "arch:noarch" \
	--info "origin:$I18N_PKG_NAME" \
	--info "url:https://github.com/ezdizzy/HomeControl" \
	--info "maintainer:HomeControl contributors" \
	--info "depends:$PKG_NAME" \
	--files "$I18N_TEMP_PKG_DIR" \
	--output "$I18N_TEMP_DIR/${I18N_PKG_NAME}_${PKG_VERSION}.apk"

mv "$I18N_TEMP_DIR/${I18N_PKG_NAME}_${PKG_VERSION}.apk" \
	"$BASE_DIR/${I18N_PKG_NAME}_${PKG_VERSION}_all.apk"
echo "Built: ${I18N_PKG_NAME}_${PKG_VERSION}_all.apk"

rm -rf "$TEMP_DIR" "$I18N_TEMP_DIR"
