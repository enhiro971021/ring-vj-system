import { defineConfig } from 'vite';
import { localMediaPlugin } from './server/media-plugin.ts';

export default defineConfig({
  plugins: [localMediaPlugin()],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
