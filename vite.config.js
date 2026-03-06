import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'docs',
    // Ensure /public/vad/ assets are copied to docs/vad/
    assetsInlineLimit: 0,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  // Serve /public/vad/ at /vad/ in dev mode (automatic via public/)
  optimizeDeps: {
    exclude: ['@ricky0123/vad-web', 'onnxruntime-web']
  }
})
