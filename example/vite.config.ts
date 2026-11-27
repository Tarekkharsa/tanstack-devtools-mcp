import react from '@vitejs/plugin-react'
import { loopsight } from 'loopsight/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

interface Post {
  id: number
  title: string
  likes: number
}

/** A three-post API in memory, so the example makes real requests. */
function fakeApi(): Plugin {
  const posts: Array<Post> = [
    { id: 1, title: 'Queries are a cache', likes: 3 },
    { id: 2, title: 'Routes are state', likes: 5 },
    { id: 3, title: 'Agents need eyes', likes: 8 },
  ]
  return {
    name: 'example-api',
    configureServer(server) {
      server.middlewares.use('/api/posts', (request, response) => {
        const send = (status: number, body: unknown) => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(body))
        }
        const [, id, action] = (request.url ?? '/').split('?')[0]!.split('/')
        setTimeout(() => {
          if (!id) return send(200, posts)
          const post = posts.find((candidate) => candidate.id === Number(id))
          if (!post) return send(404, { message: `Post ${id} not found` })
          if (action === 'like' && request.method === 'POST') post.likes += 1
          send(200, post)
        }, 80)
      })
    },
  }
}

export default defineConfig({
  // Vite DevTools is optional. With it on, the same tools are also on its MCP route.
  devtools: process.env.VITE_DEVTOOLS === '1',
  plugins: [
    react(),
    fakeApi(),
    loopsight({
      actions: true,
      ...(process.env.MCP_PORT ? { port: Number(process.env.MCP_PORT) } : {}),
      // With Vite DevTools on, MCP_STANDALONE=0 leaves its route as the only endpoint.
      standalone: process.env.MCP_STANDALONE !== '0',
    }),
  ],
})
