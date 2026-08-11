// Side-effect-only module: loads .env before anything else runs. Must be the
// FIRST import in every entrypoint (server.ts, chargeServer.ts, demo.ts,
// demoAgent.ts) — ES module imports are evaluated before the importing
// module's own top-level code, so a `process.loadEnvFile()` call sitting in
// server.ts itself runs too late for modules server.ts imports (e.g.
// chargeServer.ts's own top-level `Mppx.create()`, which reads env vars
// immediately). Centralizing it here and importing it first everywhere
// avoids relying on import order between sibling modules to get this right.
process.loadEnvFile(new URL("../.env", import.meta.url));
