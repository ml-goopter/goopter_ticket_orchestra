import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The api is a separate process (apps/api); proxy /api in dev so the
    // client's default baseUrl ("/api") works without CORS (design.md §2).
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
