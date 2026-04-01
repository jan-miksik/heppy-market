import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { fileURLToPath } from 'url'

// cosmjs-types@0.10.x has an empty `exports` field (no subpath mappings),
// so Vite's resolver rejects deep imports. Bypass the exports map by
// resolving subpaths directly to the package root on disk.
const cosmjsRoot = fileURLToPath(new URL('../../node_modules/cosmjs-types', import.meta.url))

function fixCosmjsTypes() {
  return {
    name: 'fix-cosmjs-types',
    enforce: 'pre',  // run before Vite's built-in commonjs--resolver
    resolveId(id) {
      if (id.startsWith('cosmjs-types/')) {
        const subpath = id.slice('cosmjs-types/'.length)
        // Add .js extension if missing (CJS require omits it)
        const resolved = subpath.endsWith('.js') ? subpath : `${subpath}.js`
        return { id: `${cosmjsRoot}/${resolved}`, moduleSideEffects: false }
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, process: true } }),
    fixCosmjsTypes(),
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'wagmi', '@tanstack/react-query', 'viem'],
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: 'fix-cosmjs-types-esbuild',
          setup(build) {
            build.onResolve({ filter: /^cosmjs-types\// }, (args) => {
              const subpath = args.path.slice('cosmjs-types/'.length)
              const resolved = subpath.endsWith('.js') ? subpath : `${subpath}.js`
              return { path: `${cosmjsRoot}/${resolved}` }
            })
          },
        },
      ],
    },
  },
  build: {
    commonjsOptions: { transformMixedEsModules: true },
  },
})
