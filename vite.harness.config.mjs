// Test harness: runs the app with fake Firebase (harness/stubs) so screens can be
// captured without touching the real database. Start it with:
//   ./node_modules/.bin/vite --config vite.harness.config.mjs   (serves http://localhost:5199)
// The stubs read localStorage switches (h-member, h-host, h-tv, h-gs, h-nphotos, …) to set up a scene.
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const S = ROOT + 'harness';
export default {
  root: ROOT,
  plugins: [react(), tailwindcss()],
  resolve: { alias: [
    { find: /^firebase\/app$/, replacement: S + '/stubs/app.ts' },
    { find: /^firebase\/auth$/, replacement: S + '/stubs/auth.ts' },
    { find: /^firebase\/firestore$/, replacement: S + '/stubs/firestore.ts' },
    { find: /^firebase\/storage$/, replacement: S + '/stubs/storage.ts' },
  ] },
  server: { port: 5199, strictPort: true, fs: { allow: [ROOT, '/tmp'] } },
  cacheDir: ROOT + 'node_modules/.vite-harness',
};
