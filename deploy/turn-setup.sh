#!/usr/bin/env bash
# Установка TURN-сервера (coturn) для «Созвона» на чистый Ubuntu/Debian.
# Запуск (от root):  curl -fsSL https://raw.githubusercontent.com/martdegarcon/sozvon/main/deploy/turn-setup.sh | bash -s -- turn.example.ru
# Перед запуском: A-запись turn.example.ru → IP этого сервера.
# В конце скрипт напечатает секрет — его нужно вписать в переменную TURN_SECRET приложения.
set -euo pipefail
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Укажите домен: bash turn-setup.sh turn.example.ru"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "==> Устанавливаю coturn и certbot"
apt-get update -qq
apt-get install -y -qq coturn certbot curl >/dev/null

IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
echo "==> Внешний IP: $IP"
RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ "$RESOLVED" != "$IP" ]; then
  echo "!! $DOMAIN указывает на '${RESOLVED:-ничего}', а нужно на $IP. Добавьте A-запись и запустите скрипт снова."; exit 1
fi

echo "==> Получаю TLS-сертификат для $DOMAIN"
systemctl stop coturn 2>/dev/null || true
certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
mkdir -p /etc/coturn/certs
install -m 0644 "$CERT_DIR/fullchain.pem" /etc/coturn/certs/cert.pem
install -m 0640 -g turnserver "$CERT_DIR/privkey.pem" /etc/coturn/certs/key.pem
# Обновлённый сертификат копируем и перезапускаем coturn
cat > /etc/letsencrypt/renewal-hooks/deploy/coturn.sh <<HOOK
#!/bin/sh
install -m 0644 $CERT_DIR/fullchain.pem /etc/coturn/certs/cert.pem
install -m 0640 -g turnserver $CERT_DIR/privkey.pem /etc/coturn/certs/key.pem
systemctl restart coturn
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh

SECRET_FILE=/etc/coturn/sozvon-secret
if [ ! -s "$SECRET_FILE" ]; then head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; fi
SECRET="$(cat "$SECRET_FILE")"

echo "==> Пишу конфигурацию"
cat > /etc/turnserver.conf <<CONF
# Созвон: TURN для видеозвонков
listening-port=3478
tls-listening-port=443
alt-tls-listening-port=5349
external-ip=$IP
realm=$DOMAIN
server-name=$DOMAIN
use-auth-secret
static-auth-secret=$SECRET
cert=/etc/coturn/certs/cert.pem
pkey=/etc/coturn/certs/key.pem
cipher-list="ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
no-tlsv1
no-tlsv1_1
min-port=49152
max-port=65535
fingerprint
no-cli
no-multicast-peers
no-software-attribute
stale-nonce=600
user-quota=12
total-quota=1200
# не даём использовать TURN для доступа во внутренние сети
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
log-file=syslog
simple-log
CONF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || echo "TURNSERVER_ENABLED=1" > /etc/default/coturn

# Порт 443 без root
mkdir -p /etc/systemd/system/coturn.service.d
cat > /etc/systemd/system/coturn.service.d/override.conf <<'OVR'
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=65535
OVR

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 3478/tcp; ufw allow 3478/udp; ufw allow 443/tcp; ufw allow 5349/tcp; ufw allow 49152:65535/udp
fi

systemctl daemon-reload
systemctl enable --now coturn
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn && echo "==> coturn запущен" || { journalctl -u coturn -n 30 --no-pager; exit 1; }

cat <<DONE

============================================================
 TURN-сервер готов: $DOMAIN ($IP)
 Порты: 3478 UDP/TCP, 443 TLS, 5349 TLS, 49152-65535 UDP

 В настройках приложения (Amvera → Переменные) добавьте:
   TURN_HOST   = $DOMAIN
   TURN_TLS    = 1
   TURN_SECRET = $SECRET      <- секрет, держите в тайне
 и перезапустите приложение.
============================================================
DONE
