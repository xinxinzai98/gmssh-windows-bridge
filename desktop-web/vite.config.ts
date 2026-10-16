import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { outDir: "../gmssh_windows_bridge/desktop_web", emptyOutDir: true,
    rollupOptions: { input: { index: 'index.html', files: 'files.html' } } },
});
