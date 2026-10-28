import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error módulo JS sin tipos
import { configScript, handleApiProxy, handleBff, webConfig } from './bff.mjs';

/** En desarrollo, el mismo BFF que en producción (server.mjs) corre como middleware de Vite. */
function bff(): Plugin {
  return {
    name: 'geo-bff',
    configureServer(server) {
      const env = loadEnv('development', '../../', '');
      const cfg = webConfig({ ...env, ...process.env, NODE_ENV: 'development' });
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/config.js') {
          res.setHeader('Content-Type', 'application/javascript');
          return res.end(configScript(cfg));
        }
        if (await handleBff(req, res, cfg)) return;
        if (await handleApiProxy(req, res, cfg)) return;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), bff()],
  server: { port: 5173, strictPort: true },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});
