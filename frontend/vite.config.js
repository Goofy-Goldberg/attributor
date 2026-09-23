import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api/auth": process.env.VITE_AUTH_PROXY_TARGET ?? "http://127.0.0.1:3000",
      "/api": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8000",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
