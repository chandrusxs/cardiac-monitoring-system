import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { httpServer } from './server/index.js'

let apiServer

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'auto-start-api',
      configureServer(server) {
        if (!apiServer) {
          // Attach error handler BEFORE calling listen to catch EADDRINUSE
          httpServer.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
              console.log('API server already running on port 4000, reusing.');
            } else {
              console.error('API server error:', e);
            }
          });
          try {
            apiServer = httpServer.listen(4000, () => {
              console.log('ThingSpeak proxy API running on http://localhost:4000')
            });
          } catch (e) {
            console.log('API server start failed, port likely in use:', e.message);
          }
        }

        server.httpServer?.on('close', () => {
          if (apiServer) {
            apiServer.close()
            apiServer = undefined
          }
        })
      },
    },
  ],
  build: {
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
