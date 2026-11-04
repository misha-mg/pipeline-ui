// The console's notifications: short messages that rise in at the bottom right and leave by
// themselves. An action's refusal is an error, a finished pull request a success, a run moving to
// its next stage information. They replace the notice that stayed until it was dismissed by hand.
import { ref } from 'vue'

export type ToastKind = 'info' | 'success' | 'error'
export type Toast = {
  id: number
  kind: ToastKind
  title: string
  detail?: string | undefined
  link?: { label: string; href: string } | undefined
  /** How long it stays, in ms; the bar under it runs down over that time. */
  ms: number
}

const LIFETIME: Record<ToastKind, number> = { info: 5000, success: 7000, error: 8000 }
const MAX = 5

export const toasts = ref<Toast[]>([])
let nextId = 1
const timers = new Map<number, { handle: ReturnType<typeof setTimeout>; endsAt: number; left: number }>()

export function notify(kind: ToastKind, title: string, detail?: string, link?: Toast['link']): void {
  // The same message twice in a row (a double click, two polls) shows once.
  const last = toasts.value.at(-1)
  if (last && last.kind === kind && last.title === title && last.detail === detail) return
  const toast: Toast = { id: nextId++, kind, title, detail, link, ms: LIFETIME[kind] }
  toasts.value = [...toasts.value, toast].slice(-MAX)
  arm(toast.id, toast.ms)
}

export function dismiss(id: number): void {
  clearTimeout(timers.get(id)?.handle)
  timers.delete(id)
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function arm(id: number, ms: number): void {
  timers.set(id, { handle: setTimeout(() => dismiss(id), ms), endsAt: Date.now() + ms, left: ms })
}

/** Held while the pointer is over it, so it can be read; it gets back what time it had left. */
export function hold(id: number): void {
  const t = timers.get(id)
  if (!t) return
  clearTimeout(t.handle)
  t.left = Math.max(800, t.endsAt - Date.now())
}

export function release(id: number): void {
  const t = timers.get(id)
  if (t) arm(id, t.left)
}
