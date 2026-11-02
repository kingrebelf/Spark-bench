// Entry point: `node server.ts` (Node 22.6+ with type stripping; on by default from Node 23.6).
import { createServer } from "node:http";
import { configFromEnv, createRelay } from "./lib.ts";

const cfg = configFromEnv(process.env);
const handle = createRelay(cfg);
const port = Number(process.env.PORT) || 8787;
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("unhandled", e);
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":"Internal error."}'); }
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, () => console.log(`SparkBench feedback relay on :${port} → ${cfg.repo} (per IP ${cfg.perIp}/${cfg.perIpWindowMs / 60000} min, global ${cfg.global}/h, trustProxy=${cfg.trustProxy})`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
