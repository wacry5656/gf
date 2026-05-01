import net from 'node:net'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

function isPortOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })

    const finish = (result: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function resolveDevApiTarget(env: Record<string, string>): Promise<string> {
  const fallbackPorts = ['3000', '3002']
  const preferredTarget = env.VITE_DEV_API_TARGET || `http://127.0.0.1:${env.PORT || '3000'}`
  const candidateTargets = [
    preferredTarget,
    ...fallbackPorts.map((port) => `http://127.0.0.1:${port}`),
  ]
  const uniqueTargets = Array.from(new Set(candidateTargets))

  for (const target of uniqueTargets) {
    try {
      const url = new URL(target)
      const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'))
      if (await isPortOpen(url.hostname, port)) {
        if (target !== preferredTarget) {
          console.warn(`[vite] API proxy fallback: ${preferredTarget} unavailable, using ${target}`)
        } else {
          console.log(`[vite] API proxy target: ${target}`)
        }
        return target
      }
    } catch {
      // Ignore invalid candidate targets and continue trying the next one.
    }
  }

  console.warn(`[vite] No API target detected; defaulting to ${preferredTarget}`)
  return preferredTarget
}

export default defineConfig(async ({ command, mode }) => {
  const workspaceRoot = path.resolve(__dirname, '..')
  const env = loadEnv(mode, workspaceRoot, '')
  const apiTarget = command === 'serve'
    ? await resolveDevApiTarget(env)
    : env.VITE_DEV_API_TARGET || `http://127.0.0.1:${env.PORT || '3000'}`

  return {
    envDir: workspaceRoot,
    plugins: [vue()],
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
