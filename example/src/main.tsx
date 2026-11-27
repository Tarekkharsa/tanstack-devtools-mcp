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
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Home } from './Home'

interface Post {
  id: number
  title: string
  likes: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/posts${path}`, init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.message)
  return body
}

const api = {
  list: () => request<Array<Post>>(''),
  get: (id: number) => request<Post>(`/${id}`),
  like: (id: number) => request<Post>(`/${id}/like`, { method: 'POST' }),
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
})

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
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
  component: Home,
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
  // The plugin finds the QueryClient here; the app has no devtools code.
  context: { queryClient },
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

if (import.meta.env.DEV) {
  // Optional: any code can add its own tools the way TanStack Devtools documents.
  registerDevtoolsTools({
    pluginId: 'example',
    tools: [
      {
        name: 'getPosts',
        description: 'The posts as the API returns them, bypassing the query cache.',
        annotations: { readOnlyHint: true },
        execute: () => api.list(),
      },
      {
        name: 'likePost',
        description: 'Adds one like to a post through the API.',
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
