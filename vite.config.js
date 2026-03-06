import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'docs', assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  }
})
