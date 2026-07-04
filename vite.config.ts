import { defineConfig } from 'vite';
// PORT env override lets tooling (e.g. preview harnesses) assign a free port; defaults to 5173.
export default defineConfig({
  base: './',
  server: { port: Number(process.env.PORT) || 5173 },
});
