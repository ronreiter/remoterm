/** True on phones/tablets: the primary pointer is coarse or the device reports touch points. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  return coarse || (navigator.maxTouchPoints ?? 0) > 0
}
