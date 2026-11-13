# Self-host Caddy with the Cloudflare DNS provider (ACME DNS-01), built by
# scripts/selfhost/install.sh as dominusnode-caddy:selfhost. Every version and
# base image is pinned (multi-arch index digests); bump all of them together.
#   caddy                           v2.11.9 (caddy:2.11.9-builder-alpine, caddy:2.11.9-alpine)
#   github.com/caddy-dns/cloudflare v0.2.4
FROM caddy:2.11.9-builder-alpine@sha256:646fee578e680989ca5c7fd1ce6f1de574d19fd71ef2221810cc0510a9f40c86 AS build
RUN xcaddy build v2.11.9 --with github.com/caddy-dns/cloudflare@v0.2.4 \
 && ./caddy list-modules | grep -qx 'dns.providers.cloudflare'

FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
COPY --from=build /usr/bin/caddy /usr/bin/caddy
