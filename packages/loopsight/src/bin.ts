#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { startServer } from './server.js'

const usage = `loopsight [--port <n>] [--size <n>] [--actions] [--origin <url>]...

Runs the MCP server without Vite. In the app, call:
  import { connect } from 'loopsight/client'
  connect({ url: 'ws://127.0.0.1:<port>/bridge' })

  --port     Port on 127.0.0.1. Default 4777.
  --size     Events kept per session. Default 1000.
  --actions  Register the tools that change the app.
  --origin   Extra page origin allowed to connect. Repeatable.
`

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    size: { type: 'string' },
    actions: { type: 'boolean', default: false },
    origin: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  process.stdout.write(usage)
  process.exit(0)
}

const number = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(`--${name} must be a whole number\n`)
    process.exit(1)
  }
  return parsed
}

const port = number(values.port, 'port')
const size = number(values.size, 'size')

try {
  const server = await startServer({
    ...(port !== undefined ? { port } : {}),
    ...(size !== undefined ? { size } : {}),
    actions: values.actions,
    ...(values.origin ? { origins: values.origin } : {}),
  })
  process.stdout.write(
    `loopsight\n  MCP:    ${server.mcpUrl}\n  Bridge: ${server.bridgeUrl}\n  Actions ${values.actions ? 'on' : 'off'}\n`,
  )
} catch (error) {
  process.stderr.write(
    `Could not start: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
