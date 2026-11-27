# Egress allow-list proxy (task P4-02): tinyproxy, configured at start from env.
# Build: docker build -f egress-proxy.Dockerfile -t lathe/egress-proxy:p4-02 integrations/kiro/sandbox-image
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache tinyproxy \
 && adduser -D -u 10002 proxy

COPY --chmod=0755 egress-proxy-entrypoint.sh /usr/local/bin/egress-proxy-entrypoint
USER 10002:10002
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/egress-proxy-entrypoint"]
