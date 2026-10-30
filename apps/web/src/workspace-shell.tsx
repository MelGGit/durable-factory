import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';

const STORAGE_KEY = 'factory.sidebar.layout.v1';
const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 288;

function readLayout(): { width: number; collapsed: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && Number.isFinite(saved.width)) {
      return {
        width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved.width)),
        collapsed: saved.collapsed === true,
      };
    }
  } catch {
    // Use the default layout when storage is unavailable or invalid.
  }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

export function SidebarBrand({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  controls?: string;
}) {
  return (
    <div className="sidebar-branding">
      <a className="chat-brand" href="/">
        <span className="brand-mark" aria-hidden="true" />
        <strong>Durable Factory</strong>
      </a>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={open ? 'Close sidebar' : 'Open sidebar'}
        title={open ? 'Close sidebar' : 'Open sidebar'}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        <Icon name={open ? 'sidebar-close' : 'sidebar-open'} size={18} />
      </button>
    </div>
  );
}

/** One sidebar owns its branding, navigation, and full-height resize handle. */
export function WorkspaceShell({
  mobile,
  header,
  navigation,
  children,
}: {
  mobile: boolean;
  header: React.ReactNode;
  navigation: React.ReactNode;
  children: React.ReactNode;
}) {
  const [layout, setLayout] = useState(readLayout);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<
    { pointer: number; x: number; width: number } | undefined
  >(undefined);
  const maxWidth = Math.max(
    MIN_WIDTH,
    Math.min(MAX_WIDTH, viewportWidth - 400),
  );
  const width = Math.min(layout.width, maxWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Resizing and collapsing still work without persistent storage.
    }
  }, [layout]);

  useEffect(() => {
    if (mobile) {
      drag.current = undefined;
      setResizing(false);
    }
  }, [mobile]);

  const resize = (next: number) =>
    setLayout((previous) => ({
      ...previous,
      width: Math.min(maxWidth, Math.max(MIN_WIDTH, next)),
    }));
  const stopResize = () => {
    drag.current = undefined;
    setResizing(false);
  };

  return (
    <div
      className={`chat-shell${mobile ? '' : ' desktop-shell'}${!mobile && layout.collapsed ? ' sidebar-collapsed' : ''}${resizing ? ' sidebar-resizing' : ''}`}
      style={
        {
          '--sidebar-width': `${layout.collapsed ? 0 : width}px`,
          '--sidebar-min-width': `${MIN_WIDTH}px`,
        } as React.CSSProperties
      }
    >
      {!mobile && (
        <>
          <aside
            id="workspace-sidebar"
            className="desktop-navigation"
            aria-label="Conversation navigation"
          >
            <SidebarBrand
              open={!layout.collapsed}
              controls="workspace-navigation"
              onToggle={() =>
                setLayout((previous) => ({
                  ...previous,
                  collapsed: !previous.collapsed,
                }))
              }
            />
            <div
              id="workspace-navigation"
              className="sidebar-content"
              hidden={layout.collapsed}
            >
              {navigation}
            </div>
            <div
              className="sidebar-resizer"
              hidden={layout.collapsed}
              role="separator"
              tabIndex={0}
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-controls="workspace-sidebar"
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={maxWidth}
              aria-valuenow={width}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  pointer: event.pointerId,
                  x: event.clientX,
                  width,
                };
                setResizing(true);
              }}
              onPointerMove={(event) => {
                if (drag.current?.pointer !== event.pointerId) return;
                resize(drag.current.width + event.clientX - drag.current.x);
              }}
              onPointerUp={stopResize}
              onPointerCancel={stopResize}
              onLostPointerCapture={stopResize}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 40 : 10;
                const next =
                  event.key === 'ArrowLeft'
                    ? width - step
                    : event.key === 'ArrowRight'
                      ? width + step
                      : event.key === 'Home'
                        ? MIN_WIDTH
                        : event.key === 'End'
                          ? maxWidth
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                resize(next);
              }}
            />
          </aside>
          <div className="workspace-topbar">{header}</div>
        </>
      )}
      <main className="chat-main">
        {mobile && header}
        {children}
      </main>
    </div>
  );
}
