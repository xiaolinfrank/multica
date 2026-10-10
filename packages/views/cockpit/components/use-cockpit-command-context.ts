"use client";

import { useEffect, useRef } from "react";
import { useNavigation } from "../../navigation";

/** A late receipt may settle its captured draft, but must not navigate a reader who has moved elsewhere. */
export function useCockpitCommandContext(identity: string) {
  const navigation = useNavigation();
  const signature = JSON.stringify([identity, navigation.pathname, navigation.searchParams.toString()]);
  const current = useRef({ signature, generation: 0 });
  if (current.current.signature !== signature) current.current = { signature, generation: current.current.generation + 1 };
  const generation = current.current.generation;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return () => {
    const captured = generation;
    return () => mounted.current && current.current.generation === captured;
  };
}
