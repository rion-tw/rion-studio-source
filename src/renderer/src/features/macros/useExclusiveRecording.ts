import { useCallback, useEffect, useRef, useState } from "react";

// Every recorder captures window keydown, so only one may listen at a time.
let stopActiveRecording: (() => void) | null = null;

/** Recording state where starting one key or shortcut recorder stops the others. */
export function useExclusiveRecording(): [boolean, (isRecording: boolean) => void] {
  const [isRecording, setIsRecording] = useState(false);
  const stopRef = useRef(() => setIsRecording(false));

  const updateRecording = useCallback((next: boolean): void => {
    const stop = stopRef.current;
    if (next) {
      if (stopActiveRecording && stopActiveRecording !== stop) stopActiveRecording();
      stopActiveRecording = stop;
    } else if (stopActiveRecording === stop) {
      stopActiveRecording = null;
    }
    setIsRecording(next);
  }, []);

  useEffect(() => {
    const stop = stopRef.current;
    return () => {
      if (stopActiveRecording === stop) stopActiveRecording = null;
    };
  }, []);

  return [isRecording, updateRecording];
}
