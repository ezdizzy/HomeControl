# HomeControl (luci-app-homecontrol)

Расширенный родительский контроль и управление доступом для OpenWrt в LuCI.

## Возможности

- **Dashboard** — живой обзор всех устройств: кто онлайн, кто заблокирован и почему (цветовые метки).
- **Clients** — управление клиентами: быстрый блок/разблок, блок «на 30 минут / 1 час / 2 часа», добавление из списка или вручную по IP/MAC.
- **Wi-Fi** — включение/выключение радиомодулей и отдельных SSID; автоматическое отключение по расписанию.
- **Site Rules** — правила блокировки сайтов (домены через DNS → NXDOMAIN) и IP/подсетей (через nftables).
- **Schedules** — планировщики 4 типов:
  - `daily` — ежедневное окно (например 07:00–21:00);
  - `weekly` — по выбранным дням недели;
  - `range` — целодневный блок между датами;
  - `timer` — разовый точный интервал.
  Окна могут переходить через полночь (21:00 → 07:00).
- **Journal** — журнал событий с цветными метками + хвост сервисного лога.
- **Pause** — переключатель «разрешить всё» на дашборде (родительский override).

## Как это работает

| Механизм | Реализация |
|---|---|
| Блокировка клиента | nftables таблица `inet homecontrol`, sets `blocked_v4` (IP) и `blocked_macs` (MAC), chain forward priority -100 |
| Блокировка домена | dnsmasq `server=/domain/` → NXDOMAIN |
| Wi-Fi | `uci set wireless.<iface>.disabled` + `wifi reload`, восстановление при остановке сервиса |
| Планировщик | ucode-демон (`engine.uc`, procd) проверяет состояние раз в минуту и перезапускает `apply.uc` только при изменении |
| Состояние | UCI `/etc/config/homecontrol`, журнал `/var/run/homecontrol/events.json` |

## Зависимости

- OpenWrt с fw4 (firewall4), dnsmasq, ucode (+ модули fs/uci/ubus), LuCI (JS-вьюхи).
- Аппаратно независим (`all`/`noarch`).

## Установка

```sh
# apk (OpenWrt 24.10+/25.x)
apk add --allow-untrusted ./luci-app-homecontrol_*.apk

# opkg (OpenWrt 23.05)
opkg install ./luci-app-homecontrol_*.ipk
```

После установки LuCI → Services → HomeControl.

## Сборка через GitHub Actions

Workflow `.github/workflows/build.yml` собирает **ipk + apk** на каждый push
и публикует Release при теге `v*.*.*` или ручном запуске с версией.

## Структура

```
Makefile                        — пакет OpenWrt
htdocs/.../view/homecontrol/    — JS-вьюхи LuCI (7 вкладок)
root/etc/config/homecontrol     — UCI-конфиг (conffile)
root/etc/homecontrol/scripts/   — apply.uc (enforcement), engine.uc (планировщик), homecontrol.uc (lib)
root/etc/init.d/homecontrol     — procd-сервис
root/usr/share/rpcd/ucode/      — RPC-бэкенд luci.homecontrol (12 методов)
root/usr/share/luci/menu.d/     — меню LuCI
root/usr/share/rpcd/acl.d/      — ACL
```

## Лицензия

GPL-2.0-only
