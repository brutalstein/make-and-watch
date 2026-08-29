import { useEffect } from 'react';

const STORAGE_KEY = 'makewatch.studio.director-archive-open';
const BOUND_ATTRIBUTE = 'data-makewatch-archive-preference';

function preferredOpen() {
  try { return window.localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

function persist(open: boolean) {
  try { window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch { /* presentation preference is best-effort */ }
}

export function DirectorArchivePreferenceController() {
  useEffect(() => {
    let cleanupBound: (() => void) | null = null;

    const bind = () => {
      const button = document.querySelector<HTMLButtonElement>('button[title="Conversation archive"]');
      const archive = document.querySelector<HTMLElement>('.director-conversations');
      if (!button || !archive || button.hasAttribute(BOUND_ATTRIBUTE)) return;

      button.setAttribute(BOUND_ATTRIBUTE, '1');
      const desired = preferredOpen();
      const actual = archive.classList.contains('director-conversations--open');
      if (actual !== desired) button.click();

      const onClick = () => {
        window.requestAnimationFrame(() => {
          persist(archive.classList.contains('director-conversations--open'));
        });
      };
      button.addEventListener('click', onClick);
      cleanupBound = () => {
        button.removeEventListener('click', onClick);
        button.removeAttribute(BOUND_ATTRIBUTE);
      };
    };

    bind();
    const observer = new MutationObserver(bind);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cleanupBound?.();
    };
  }, []);

  return null;
}
