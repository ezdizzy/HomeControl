# HomeControl (luci-app-homecontrol)

Расширенный родительский контроль и управление доступом для OpenWrt в LuCI.

## Возможности

- **Dashboard** — живой обзор всех устройств: кто онлайн, кто заблокирован и почему (цветовые метки), обратный отсчёт до снятия блока.
- **Clients** — управление клиентами: мгновенный блок/разрешение и блок на произвольное время (минуты / часы / дни) с автовосстановлением доступа; добавление вручную по IP и/или MAC.
- **Wi-Fi** — включение/выключение радиомодулей и отдельных SSID, выключение на время (включится само), отключение/включение по расписанию. Ручное переключение не перехватывается автоматикой.
- **Site Rules** — блокировка сайтов (домены через DNS → NXDOMAIN) и IP/подсетей (через nftables) **для всей сети или для выбранных клиентов** (например, одному ребёнку нельзя TikTok, а второму можно). Каждое правило можно ограничить окном времени (дни недели, часы, диапазон дат) или временно приостановить («разрешить на час») с автовозобновлением.
- **Schedules** — планировщики 4 типов для клиентов и Wi-Fi:
  - `daily` — ежедневное окно (например 07:00–21:00);
  - `weekly` — по выбранным дням недели;
  - `range` — целодневный блок между датами;
  - `timer` — разовый точный интервал.
  Окна могут переходить через полночь (21:00 → 07:00). Режим «Только в окне» инвертирует логику (вне окна всё заблокировано / Wi-Fi выключен).
- **Journal** — журнал событий с цветными метками + хвост сервисного лога.
- **Pause** — переключатель «разрешить всё» на дашборде (родительский override).
- **Обновления** — проверка новой версии и установка прямо из Settings (GitHub Releases).

## Как это работает

| Механизм | Реализация |
|---|---|
| Блокировка клиента | nftables таблица `inet homecontrol`: sets `blocked_v4` (IP) и `blocked_macs` (MAC), chain forward priority -100 |
| Блокировка домена (вся сеть) | dnsmasq `server=/domain/` → NXDOMAIN |
| Блокировка IP-правил (вся сеть) | nftables set `blocked_rule_v4` (destination drop) |
| Блокировка домена (выбранные клиенты) | отдельный dnsmasq-инстанс на клиента (NXDOMAIN только для его доменов, остальное форвардит в главный dnsmasq) + nft-редирект DNS-трафика клиента (UDP/TCP dst 53) на этот инстанс — работает даже если в устройстве вручную прописан чужой DNS |
| Блокировка IP-правил (выбранные клиенты) | per-client nft sets `pc_<id>_v4` + drop по src клиента |
| Защита от обхода (для фильтруемых клиентов) | блокировка DoT/DoQ (порт 853) |
| Wi-Fi | `uci set wireless.<iface>.disabled` + `wifi reload`; временные интервалы — через маркер-файлы с автовозвратом |
| Планировщик | ucode-демон (`engine.uc`, procd) проверяет состояние раз в минуту и перезапускает `apply.uc` только при изменении |
| Состояние | UCI `/etc/config/homecontrol`, журнал `/var/run/homecontrol/events.json` |

### Ограничения per-client фильтрации

- Фильтрация по доменам работает на IPv4-клиентах (IPv6 — в планах).
- DNS-over-HTTPS (DoH) обойти блокировку теоретически может — детектировать DoH-эндпоинты приложение не пытается.
- Если у клиента не задан IP и MAC, per-client правила к нему применены быть не могут (клиент помечается в логе).

## Зависимости

- OpenWrt с fw4 (firewall4), dnsmasq, ucode (+ модули fs/uci/ubus), LuCI (JS-вьюхи).
- Аппаратно независим (`all`/`noarch`).

## Установка

Проще всего — скриптом. Он сам определит пакетный менеджер (apk или opkg),
скачает свежий релиз с GitHub и установит приложение вместе с русским переводом:

```sh
sh install.sh            # последняя версия
sh install.sh v0.2.0     # конкретная версия
```

Скрипт нужно выполнить на роутере (через SSH). Скачайте его на роутер, например:

```sh
wget -O /tmp/install.sh https://raw.githubusercontent.com/ezdizzy/HomeControl/master/install.sh
sh /tmp/install.sh
```

Либо вручную скачайте пакет из [Releases](https://github.com/ezdizzy/HomeControl/releases)
и установите:

```sh
# apk (OpenWrt 25.x)
apk add --allow-untrusted ./luci-app-homecontrol_*.apk

# opkg (OpenWrt 23.05 / 24.10)
opkg install ./luci-app-homecontrol_*.ipk
```

После установки LuCI → Services → HomeControl.

## Обновление

Вкладка **Settings → Application → Check for updates** — приложение проверит
GitHub и установит новую версию в один клик. Либо повторите установку скриптом:
он обновит пакет до последнего релиза (настройки сохраняются).

## Структура

```
Makefile                        — пакет OpenWrt
install.sh                      — установочный скрипт
htdocs/.../view/homecontrol/    — JS-вьюхи LuCI (7 вкладок)
root/etc/config/homecontrol     — UCI-конфиг (conffile)
root/etc/homecontrol/scripts/   — apply.uc (enforcement), engine.uc (планировщик), homecontrol.uc (lib)
root/etc/init.d/homecontrol     — procd-сервис
root/usr/share/rpcd/ucode/      — RPC-бэкенд luci.homecontrol
root/usr/share/luci/menu.d/     — меню LuCI
root/usr/share/rpcd/acl.d/      — ACL
```

## Лицензия

GPL-2.0-only
