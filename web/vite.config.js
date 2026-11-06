import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 5150, npm start) and Vite on VITE_PORT (default 5151). /api is proxied, so the browser only ever
// talks to one origin (same-origin writes). Ports stay inside 5150-5199.
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 5150}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 5151, strictPort: true, proxy: { "/api": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
