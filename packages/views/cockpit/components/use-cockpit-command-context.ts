"use client";

import { useEffect, useRef } from "react";
import { useNavigation } from "../../navigation";

/** A late receipt may settle its captured draft, but must not navigate a reader who has moved elsewhere. */
export function useCockpitCommandContext(identity: string) {
  const navigation = useNavigation();
  const signature = JSON.stringify([identity, navigation.pathname, navigation.searchParams.toString()]);
  const current = useRef(signature);
  current.current = signature;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return () => {
    const captured = signature;
    return () => mounted.current && current.current === captured;
  };
}
