import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// The packages import each other by name. Tests run on their source, so the
// names are pointed at it here, as tsconfig.json does for the type checker.
// Longer names come first: an alias matches by prefix.
export default defineConfig({
  resolve: {
    alias: {
      "@loopsight/core/page": here("./packages/core/src/page/index.ts"),
      "@loopsight/core/server": here("./packages/core/src/server/index.ts"),
      "@loopsight/core/protocol": here("./packages/core/src/protocol.ts"),
      "@loopsight/vite": here("./packages/vite/src/index.ts"),
      "loopsight/vite": here("./packages/loopsight/src/vite.ts"),
      "loopsight/client": here("./packages/loopsight/src/client.ts"),
      "loopsight/server": here("./packages/loopsight/src/server.ts"),
      "@loopsight/tanstack-query/page": here("./packages/tanstack-query/src/page.ts"),
      "@loopsight/tanstack-query": here("./packages/tanstack-query/src/index.ts"),
      "@loopsight/tanstack-router/page": here("./packages/tanstack-router/src/page.ts"),
      "@loopsight/tanstack-router": here("./packages/tanstack-router/src/index.ts"),
      "@loopsight/tanstack-start/page": here("./packages/tanstack-start/src/page.ts"),
      "@loopsight/tanstack-start": here("./packages/tanstack-start/src/index.ts"),
      "@loopsight/tanstack-devtools/page": here("./packages/tanstack-devtools/src/page.ts"),
      "@loopsight/tanstack-devtools": here("./packages/tanstack-devtools/src/index.ts"),
    },
  },
})
