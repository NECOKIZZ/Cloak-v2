import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // long-lived vendor chunks, so a deploy only invalidates the app code
        manualChunks: (id) =>
          /node_modules\/(\.pnpm\/)?(react|react-dom|scheduler)[@/]/.test(id) ? "react"
          : /node_modules\/(\.pnpm\/)?(viem|ox|abitype|@noble|@scure)[@/]/.test(id) ? "viem"
          : undefined,
      },
    },
  },
});
