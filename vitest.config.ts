// vitest: the project's own tests, never the ones a tool keeps under a dot directory or data/.
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { exclude: ['**/node_modules/**', 'data/**', '.*/**'] } })
