import { createContext, type ReactNode, useContext, useState } from 'react'
import { createPortal } from 'react-dom'

const SlotContext = createContext<{ el: HTMLElement | null; setEl: (el: HTMLElement | null) => void }>({
  el: null,
  setEl: () => {},
})

/** Holds the element the top bar's middle slot is; wraps the bar and the page. */
export function SlotProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  return <SlotContext.Provider value={{ el, setEl }}>{children}</SlotContext.Provider>
}

/** The middle of the top bar: the place a page's tools show up. Empty unless a page fills it. */
export function SlotTarget() {
  const { setEl } = useContext(SlotContext)
  return <div ref={setEl} className="flex h-full min-w-0 flex-1 items-center" />
}

/** What a page renders to put its tools in the top bar's middle (pages never import the bar itself). */
export function ShellSlot({ children }: { children: ReactNode }) {
  const { el } = useContext(SlotContext)
  return el ? createPortal(children, el) : null
}
