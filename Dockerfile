FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.145.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        ripgrep \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && codex --version \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

RUN mkdir -p /home/node/.codex /home/node/.livis-codex /workspace \
    && chown -R node:node /home/node/.codex /home/node/.livis-codex /workspace

ENV HOME=/home/node \
    LIVIS_CODEX_HOME=/home/node/.livis-codex \
    NODE_ENV=production

USER node

EXPOSE 8765

CMD ["node", "src/cli.js", "start"]
