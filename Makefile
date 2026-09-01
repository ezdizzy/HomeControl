# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2026 HomeControl contributors

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI app for advanced parental control and network access management
LUCI_PKGARCH:=all
LUCI_DEPENDS:= \
	+firewall4 \
	+ucode-mod-fs \
	+ucode-mod-uci \
	+ucode-mod-ubus

PKG_NAME:=luci-app-homecontrol
PKG_VERSION:=0.3.1
PKG_RELEASE:=1
PKG_MAINTAINER:=HomeControl contributors
PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE

define Package/luci-app-homecontrol/conffiles
/etc/config/homecontrol
endef

define Package/luci-app-homecontrol/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
if command -v setsid >/dev/null 2>&1; then
	setsid sh -c 'sleep 2; /etc/init.d/rpcd restart; /etc/init.d/homecontrol restart' >/dev/null 2>&1 &
else
	( sleep 2; /etc/init.d/rpcd restart; /etc/init.d/homecontrol restart ) >/dev/null 2>&1 &
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
