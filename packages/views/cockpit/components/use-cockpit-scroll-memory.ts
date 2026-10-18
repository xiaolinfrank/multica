"use client";
import { useEffect, useRef, type RefObject } from "react";
import { useCockpitScopeViewStore } from "@multica/core/cockpit";

/** Remember only viewport position; Query continues to own every displayed row. */
export function useCockpitScrollMemory(elementRef: RefObject<HTMLElement | null>, key: string, ready: boolean, filterSignature = "") {
  const previous = useRef({ key, filterSignature, generation: useCockpitScopeViewStore.getState().sessionGeneration });
  useEffect(() => {
    const element = elementRef.current; if (!element || !ready) return;
    const generation = useCockpitScopeViewStore.getState().sessionGeneration;
    const saved = useCockpitScopeViewStore.getState().plans[key];
    element.scrollTop = saved?.scrollTop ?? 0; element.scrollLeft = saved?.scrollLeft ?? 0;
    let frame = 0;
    const save = () => {
      const store = useCockpitScopeViewStore.getState();
      if (store.sessionGeneration === generation) store.updatePlan(key, { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft });
    };
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(save); };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); element.removeEventListener("scroll", onScroll); save(); };
  }, [elementRef, key, ready]);
  useEffect(() => {
    const generation = useCockpitScopeViewStore.getState().sessionGeneration;
    if (previous.current.generation === generation && previous.current.key === key && previous.current.filterSignature !== filterSignature) {
      const element = elementRef.current; if (element) element.scrollTop = 0;
      useCockpitScopeViewStore.getState().updatePlan(key, { scrollTop: 0 });
    }
    previous.current = { key, filterSignature, generation };
  }, [elementRef, key, filterSignature]);
}
