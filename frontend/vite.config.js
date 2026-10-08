import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend only allows browser calls from the origins in CORS_ORIGINS
// (default: http://localhost:3000 and http://localhost:5173), so both servers
// are pinned to one of those ports instead of silently falling back to another.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 3000, strictPort: true },
})
