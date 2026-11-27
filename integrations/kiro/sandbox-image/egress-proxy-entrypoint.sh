#!/bin/sh
# Writes the generated tinyproxy config and filter (base64 in env) to the tmpfs
# and runs tinyproxy in the foreground. Fails closed when either is missing.
set -eu
: "${TINYPROXY_CONF_B64:?missing config}"
: "${TINYPROXY_FILTER_B64:?missing filter}"
# Listen only on the internal-network address: the network alias resolves to it alone, even
# after the runner attaches the default bridge. Fail closed when it does not resolve.
LISTEN_IP=$(getent hosts egress-proxy | awk 'NR==1{print $1}')
case "$LISTEN_IP" in ''|0.0.0.0|127.*) echo 'no internal address' >&2; exit 1;; esac
printf '%s' "$TINYPROXY_CONF_B64" | base64 -d | sed "s/@LISTEN_IP@/$LISTEN_IP/" > /tmp/tinyproxy.conf
printf '%s' "$TINYPROXY_FILTER_B64" | base64 -d > /tmp/tinyproxy.filter
exec tinyproxy -d -c /tmp/tinyproxy.conf
