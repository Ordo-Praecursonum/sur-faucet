import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      // Forward API calls to the faucet backend in dev.
      '/api': 'http://localhost:8787',
    },
  },
})
