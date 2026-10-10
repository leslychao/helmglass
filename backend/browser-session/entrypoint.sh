#!/bin/sh
set -eu
: "${PROXY_IP:?PROXY_IP is required}"

# The network namespace denies every browser-originated route except its pinned egress proxy.
# Linux capabilities are dropped before Node, X11, VNC or Chromium starts.
iptables -P OUTPUT DROP
iptables -A OUTPUT -p udp -j REJECT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p tcp -d "$PROXY_IP" --dport 3128 -j ACCEPT
ip6tables -P OUTPUT DROP
ip6tables -A OUTPUT -p udp -j REJECT
ip6tables -A OUTPUT -o lo -j ACCEPT
test -d /data/artifacts
exec setpriv --reuid=1000 --regid=1000 --groups=1000,10001 --inh-caps=-all --ambient-caps=-all --bounding-set=-all /app/start-browser.sh
