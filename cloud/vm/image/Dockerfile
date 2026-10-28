# Build from the repository root: docker build -f cloud/vm/image/Dockerfile .
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/anvil
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
COPY cloud/vm/runtime/ ./cloud/vm/runtime/
WORKDIR /opt/anvil/cloud/vm/runtime
RUN npm install && npm run build
EXPOSE 8080
CMD ["node", "dist/server.js"]
