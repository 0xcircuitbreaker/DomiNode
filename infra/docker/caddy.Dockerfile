# Self-host Caddy with the Cloudflare DNS provider (ACME DNS-01), built by
# scripts/selfhost/install.sh as dominusnode-caddy:selfhost. Every version and
# base image is pinned (multi-arch index digests); bump all of them together.
#   caddy                           v2.11.9 (caddy:2.11.9-builder-alpine, caddy:2.11.9-alpine)
#   github.com/caddy-dns/cloudflare v0.2.4
FROM caddy:2.11.9-builder-alpine@sha256:29f98311e17e583811355fa62cc080f71d6f3aa19cf09a9e1494d30579f8bebf AS build
RUN xcaddy build v2.11.9 --with github.com/caddy-dns/cloudflare@v0.2.4 \
 && ./caddy list-modules | grep -qx 'dns.providers.cloudflare'

FROM caddy:2.11.9-alpine@sha256:fc9cbc100585871d18d4e451cca7021785c90a7006087427ae5ceb3e4efe6424
COPY --from=build /usr/bin/caddy /usr/bin/caddy
