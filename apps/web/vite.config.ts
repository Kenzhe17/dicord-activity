import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
// Old environment files stay intact but are deliberately not loaded by the rebuild.
export default defineConfig({ plugins: [react(), tailwind()], base: '/.proxy/', envDir: './config', server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001', '/socket.io': { target: 'http://127.0.0.1:3001', ws: true } } } });
