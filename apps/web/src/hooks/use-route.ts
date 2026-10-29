import { useEffect, useRef, useState } from 'react';
import { confirmLeave } from './use-unsaved-changes.js';

export type Route =
  | { kind: 'chat' }
  | { kind: 'settings' }
  | { kind: 'add-project' }
  | { kind: 'project-settings'; projectId: string };

/** Views live under clean paths; anything else is the conversation view. */
export function parseRoute(): Route {
  const { pathname, search } = window.location;
  const legacy = new URLSearchParams(search).get('project');
  if (pathname === '/settings' && legacy) {
    const path = `/projects/${encodeURIComponent(legacy)}/settings`;
    window.history.replaceState({}, '', path);
    return { kind: 'project-settings', projectId: legacy };
  }
  if (pathname === '/settings') return { kind: 'settings' };
  if (pathname === '/projects/new') return { kind: 'add-project' };
  const match = /^\/projects\/([^/]+)\/settings\/?$/.exec(pathname);
  if (match)
    return {
      kind: 'project-settings',
      projectId: decodeURIComponent(match[1]),
    };
  if (pathname === '/runs') window.history.replaceState({}, '', '/');
  return { kind: 'chat' };
}

/**
 * The current view, derived from the URL path. `navigate` moves between views
 * without a page load; `enterChat` switches to the conversation view and,
 * given a path, records it in the history.
 */
export function useRoute(onPop: (route: Route) => void) {
  const [route, setRoute] = useState<Route>(parseRoute);
  const popped = useRef(onPop);
  popped.current = onPop;
  const navigate = (path: string) => {
    if (!confirmLeave()) return;
    window.history.pushState({}, '', path);
    setRoute(parseRoute());
  };
  const enterChat = (path?: string) => {
    if (path !== undefined) window.history.pushState({}, '', path);
    setRoute({ kind: 'chat' });
  };
  useEffect(() => {
    const pop = () => {
      const next = parseRoute();
      setRoute(next);
      popped.current(next);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  return { route, navigate, enterChat };
}

/** Keeps `?conversation=` in step with the selected conversation. */
export function useConversationUrl(
  selected: string,
  route: Route,
  enterChat: () => void,
) {
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (first && route.kind !== 'chat') return;
    const url = new URL(window.location.href);
    const existing = url.searchParams.get('conversation') ?? '';
    if ((selected ?? '') === existing && route.kind === 'chat') return;
    url.pathname = '/';
    url.searchParams.delete('project');
    url.searchParams.delete('empty');
    if (selected) url.searchParams.set('conversation', selected);
    else url.searchParams.delete('conversation');
    window.history.pushState({}, '', url);
    enterChat();
  }, [selected]);
}
