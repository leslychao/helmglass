import { DestroyRef, inject } from '@angular/core';

export function protectUnsavedChanges(isDirty: () => boolean): () => boolean {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (isDirty()) event.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);
  inject(DestroyRef).onDestroy(() => window.removeEventListener('beforeunload', beforeUnload));
  return () => !isDirty() || confirm('Есть несохранённые изменения. Покинуть форму?');
}
