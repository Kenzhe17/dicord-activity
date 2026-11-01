import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      '__DISCORD_CLIENT_ID__': JSON.stringify(env.VITE_DISCORD_CLIENT_ID || '1566418593191690330'),
      '__SERVER_URL__': JSON.stringify(env.VITE_SERVER_URL || (mode === 'production' ? '' : 'http://localhost:3001')),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
