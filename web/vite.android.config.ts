import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Build para el APK: rutas relativas y salida dentro de los assets de Android.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "android-html",
      transformIndexHtml(html) {
        return html
          .replace("<!-- figma:lang -->", "es")
          .replace("<!-- figma:title -->", "SafetyRoad 2.0")
          .replace(/<!-- figma:[a-z-]+ -->/g, "")
          .replace("initial-scale=1.0", "initial-scale=1.0, viewport-fit=cover");
      },
    },
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    outDir: path.resolve(__dirname, "../app/src/main/assets/www"),
    emptyOutDir: true,
  },
});
