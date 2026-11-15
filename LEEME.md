# SafetyRoad 2.0 – proyecto Android

- `web/`  → app React exportada de Figma Make (con acelerometro, GPS y guardado de datos agregados).
- `app/`  → envoltura Android (WebView) que carga la app compilada.

## Compilar con GitHub (sin instalar nada)
1. Sube todo el contenido de esta carpeta a un repositorio nuevo de GitHub.
2. Pestana Actions → "Build APK" (arranca solo; tarda unos 5 min).
3. Descarga el artefacto "SafetyRoad-apk" → app-debug.apk.

## Compilar con Android Studio
1. En `web/`: `pnpm install` y `pnpm run build:android` (genera app/src/main/assets/www).
2. Abre esta carpeta en Android Studio → Build → Build APK(s).

## Mapa
Sin llave de MapTiler usa el mapa oscuro de CARTO. Para MapTiler crea `web/.env` con
`VITE_MAPTILER_API_KEY=tu_llave` antes de compilar.
