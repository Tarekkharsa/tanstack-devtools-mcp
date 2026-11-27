import { registerDevtoolsTools } from '@tanstack/devtools-webmcp'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { connect } from 'tanstack-devtools-mcp/client'

interface Post {
  id: number
  title: string
  likes: number
}

const posts: Array<Post> = [
  { id: 1, title: 'Queries are a cache', likes: 3 },
  { id: 2, title: 'Routes are state', likes: 5 },
  { id: 3, title: 'Agents need eyes', likes: 8 },
]

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const api = {
  async list() {
    await wait(120)
    return posts.map((post) => ({ ...post }))
  },
  async get(id: number) {
    await wait(120)
    const post = posts.find((candidate) => candidate.id === id)
    if (!post) throw new Error(`Post ${id} not found`)
    return { ...post }
  },
  async like(id: number) {
    await wait(120)
    const post = posts.find((candidate) => candidate.id === id)
    if (!post) throw new Error(`Post ${id} not found`)
    post.likes += 1
    return { ...post }
  },
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
})

const rootRoute = createRootRoute({
  component: () => (
    <main style={{ fontFamily: 'system-ui', maxWidth: 560, margin: '2rem auto' }}>
      <nav style={{ display: 'flex', gap: 12 }}>
        <Link to="/">Home</Link>
        <Link to="/posts">Posts</Link>
      </nav>
      <Outlet />
    </main>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <p>Open Posts, then ask your agent what the page is doing.</p>,
})

const postsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/posts',
  loader: () =>
    queryClient.ensureQueryData({ queryKey: ['posts'], queryFn: api.list }),
  component: function Posts() {
    const { data = [] } = useQuery({ queryKey: ['posts'], queryFn: api.list })
    return (
      <>
        <ul>
          {data.map((post) => (
            <li key={post.id}>
              <Link to="/posts/$postId" params={{ postId: String(post.id) }}>
                {post.title}
              </Link>{' '}
              ({post.likes})
            </li>
          ))}
        </ul>
        <Outlet />
      </>
    )
  },
})

const postRoute = createRoute({
  getParentRoute: () => postsRoute,
  path: '$postId',
  loader: ({ params }) =>
    queryClient.ensureQueryData({
      queryKey: ['post', Number(params.postId)],
      queryFn: () => api.get(Number(params.postId)),
    }),
  errorComponent: ({ error }) => (
    <p role="alert">{error instanceof Error ? error.message : String(error)}</p>
  ),
  component: function PostDetail() {
    const { postId } = postRoute.useParams()
    const id = Number(postId)
    const client = useQueryClient()
    const { data } = useQuery({
      queryKey: ['post', id],
      queryFn: () => api.get(id),
    })
    const like = useMutation({
      mutationKey: ['like', id],
      mutationFn: () => api.like(id),
      onSuccess: () =>
        Promise.all([
          client.invalidateQueries({ queryKey: ['post', id] }),
          client.invalidateQueries({ queryKey: ['posts'] }),
        ]),
    })
    return (
      <article>
        <h2>{data?.title}</h2>
        <button onClick={() => like.mutate()} disabled={like.isPending}>
          Like ({data?.likes})
        </button>
      </article>
    )
  },
})

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    postsRoute.addChildren([postRoute]),
  ]),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

if (import.meta.env.DEV) {
  // The Vite plugin already connected the page; this adds the QueryClient.
  // The router is found on its own.
  connect({ queryClient })

  // Any library can add its own tools the way TanStack Devtools documents.
  registerDevtoolsTools({
    pluginId: 'example',
    tools: [
      {
        name: 'getPosts',
        description: 'The posts in the fake API, bypassing the query cache.',
        annotations: { readOnlyHint: true },
        execute: () => posts,
      },
      {
        name: 'likePost',
        description: 'Adds one like to a post in the fake API.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
        },
        execute: (input: { id: number }) => api.like(input.id),
      },
    ],
  })
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
