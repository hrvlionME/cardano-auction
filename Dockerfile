# The web app and its API server, as one image.
#
#   docker compose up --build        (see docker-compose.yml)
#
# Only the server runs here -- `deno task serve --sync`. It holds no seed
# phrase and signs nothing, so none are passed in: bidding, selling and
# settling are signed in the visitor's browser wallet.
#
# Built from the repository root because the app needs one file from the other
# half of the project: on-chain/plutus.json, the compiled scripts. Compiling
# them needs the whole Haskell toolchain, which is why that file is committed
# and simply copied in here rather than rebuilt.

# Same Deno as development, so deno.lock is read by the version that wrote it.
FROM denoland/deno:2.9.6

WORKDIR /app

# The on-chain half contributes exactly one file. src/blueprint.ts and
# web/src/chain.ts both find it at ../on-chain/plutus.json relative to
# off-chain/, so the layout inside the image mirrors the repository.
COPY on-chain/plutus.json on-chain/plutus.json

# Dependency manifests first, so that editing source code does not throw away
# the (slow) dependency download layer.
COPY off-chain/deno.json off-chain/deno.lock off-chain/
COPY off-chain/web/deno.json off-chain/web/deno.lock off-chain/web/package.json off-chain/web/
WORKDIR /app/off-chain
RUN deno install && cd web && deno install

# The source, then the browser bundle. The bundle imports the same modules the
# server uses (the @core alias in vite.config.ts), which is why both halves of
# off-chain/ must be present when it is built.
COPY off-chain/ ./
RUN deno task web:build \
 && deno cache scripts/*.ts

# Operator-held files that are not in git: photographs, and the state/ records
# of auctions opened from the command line. Mounted as volumes by compose.
RUN mkdir -p uploads state

EXPOSE 8000
CMD ["deno", "task", "serve", "--sync"]
