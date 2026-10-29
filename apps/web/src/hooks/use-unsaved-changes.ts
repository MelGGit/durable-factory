import { useEffect } from 'react';

let unsaved = false;

/** Asks before leaving a view that holds unsaved edits; true when it is fine to go. */
export function confirmLeave() {
  return (
    !unsaved ||
    window.confirm('You have unsaved changes. Leave without saving?')
  );
}

/** Call before leaving on purpose (after a save or a delete) to skip the prompt. */
export function discardUnsavedChanges() {
  unsaved = false;
}

/** Marks the view as holding unsaved edits, in-app and on page unload. */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    unsaved = dirty;
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      unsaved = false;
    };
  }, [dirty]);
}
