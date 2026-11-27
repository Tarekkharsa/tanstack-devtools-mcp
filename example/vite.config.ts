import react from '@vitejs/plugin-react'
import { tanstackDevtoolsMcp } from 'tanstack-devtools-mcp/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    tanstackDevtoolsMcp({
      actions: true,
      ...(process.env.MCP_PORT ? { port: Number(process.env.MCP_PORT) } : {}),
    }),
  ],
})
