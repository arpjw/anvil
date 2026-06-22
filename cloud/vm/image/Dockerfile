# Anvil VM image — simulates the Firecracker rootfs for local development.
# In production, the same setup is baked into a Firecracker ext4 image
# (see ./setup.sh). Here we just package it as a Docker image.

FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git \
       ripgrep \
       ca-certificates \
       curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g typescript-language-server typescript anvil-agent

COPY cloud/vm/runtime/ /runtime/
WORKDIR /runtime

RUN npm install \
 && npm run build

EXPOSE 8080

CMD ["node", "dist/server.js"]
