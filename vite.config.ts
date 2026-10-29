/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 60000 },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60000 },
});

