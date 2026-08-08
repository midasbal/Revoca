import { useEffect, useRef } from 'react';

/** The value this hook held on the PREVIOUS render, undefined on the first. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}
