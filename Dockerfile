FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g typescript-language-server typescript

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/

ENTRYPOINT ["node", "dist/index.js"]
