import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Single .env at the repo root; only VITE_* vars are exposed to the browser.
  envDir: '../..',
  server: {
    port: 5173,
    strictPort: true,
  },
});
