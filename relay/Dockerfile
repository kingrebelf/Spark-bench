# SparkBench feedback relay: no dependencies, Node runs the TypeScript directly (type stripping).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json lib.ts server.ts ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.ts"]
