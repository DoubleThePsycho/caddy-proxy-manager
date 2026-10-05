"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Asks before the browser leaves a settings page whose forms have unsaved
 * changes. Pass the returned function as the group's onDirtyChange.
 */
export function useUnsavedWarning(): (count: number) => void {
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return useCallback((count: number) => setDirty(count > 0), []);
}
