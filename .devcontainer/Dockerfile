FROM mcr.microsoft.com/devcontainers/typescript-node:22

# Install zsh extras
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Pre-install global tools as root so they're available system-wide
RUN npm install -g wrangler turbo

# Switch to non-root user (node user is built into the base image)
USER node

WORKDIR /workspace
