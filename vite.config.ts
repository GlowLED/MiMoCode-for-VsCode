import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "src/webview",
  base: "./",
  plugins: [solid()],
  build: {
    outDir: "../../out",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/webview/index.html",
      output: {
        entryFileNames: "main.js",
        assetFileNames: "main.[ext]"
      }
    }
  },
  test: {
    root: ".",
    environment: "node"
  }
});
