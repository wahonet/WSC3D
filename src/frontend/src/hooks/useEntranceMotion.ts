import { useLayoutEffect, useRef } from 'react'

interface EntranceOptions {
  duration?: number
  liftSelector?: string
  skipInitial?: boolean
}

/** Animate the existing surface, preserving viewers, drafts and in-flight work. */
export function useEntranceMotion<T extends HTMLElement>(key: string, {
  duration = 340, liftSelector = '', skipInitial = false,
}: EntranceOptions = {}) {
  const ref = useRef<T>(null)
  const previousKey = useRef(key)

  useLayoutEffect(() => {
    const changed = previousKey.current !== key
    previousKey.current = key
    const surface = ref.current
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    if (!surface || typeof surface.animate !== 'function' || reducedMotion.matches || (skipInitial && !changed)) return

    const animations: Animation[] = []
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)'
    function play(element: HTMLElement, frames: Keyframe[], milliseconds: number, name: string) {
      const animation = element.animate(frames, { duration: milliseconds, easing })
      animation.id = name
      animations.push(animation)
    }
    // Do not transform the workspace: its fixed WebGL canvas docks in viewport coordinates.
    play(surface, [{ opacity: .36 }, { opacity: 1 }], duration, 'function-enter')

    const heading = liftSelector ? surface.querySelector<HTMLElement>(liftSelector) : null
    if (heading) play(heading, [{ translate: '0 7px' }, { translate: '0 0' }], duration + 60, 'function-heading')

    const light = surface.querySelector<HTMLElement>('.function-transition-light')
    if (light) play(light, [
      { opacity: 0, transform: 'translateX(-16%)', offset: 0 },
      { opacity: .65, offset: .18 },
      { opacity: 0, transform: 'translateX(16%)', offset: 1 },
    ], duration + 160, 'function-light')

    const cancel = () => animations.forEach(animation => animation.cancel())
    reducedMotion.addEventListener('change', cancel)
    return () => { cancel(); reducedMotion.removeEventListener('change', cancel) }
  }, [key, duration, liftSelector, skipInitial])

  return ref
}
