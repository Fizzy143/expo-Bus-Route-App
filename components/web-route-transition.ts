import { Platform } from 'react-native';

export type WebRouteTransitionDirection = 'forward' | 'back';

type WebRouteTransitionMeta = {
  createdAt: number;
  direction: WebRouteTransitionDirection;
  targetPath: string;
};

const META_KEY = '__STOP_TOGO_WEB_ROUTE_TRANSITION__';
const SNAPSHOT_ID = 'stop-togo-web-route-snapshot';
const MAX_META_AGE_MS = 1500;

function getWindowObject() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return null;
  }

  return window as Window & {
    [META_KEY]?: WebRouteTransitionMeta;
  };
}

export function beginWebRouteTransition(
  sourceElement: HTMLElement | null | undefined,
  targetPath: string,
  direction: WebRouteTransitionDirection
) {
  const win = getWindowObject();
  if (!win || !(sourceElement instanceof HTMLElement)) {
    return;
  }

  clearWebRouteTransition();

  const rect = sourceElement.getBoundingClientRect();
  const snapshot = sourceElement.cloneNode(true) as HTMLElement;
  snapshot.id = SNAPSHOT_ID;
  snapshot.style.position = 'fixed';
  snapshot.style.left = `${rect.left}px`;
  snapshot.style.top = `${rect.top}px`;
  snapshot.style.width = `${rect.width}px`;
  snapshot.style.height = `${rect.height}px`;
  snapshot.style.margin = '0';
  snapshot.style.pointerEvents = 'none';
  snapshot.style.overflow = 'hidden';
  snapshot.style.background = '#152021';
  snapshot.style.zIndex = '9998';
  snapshot.style.transform = 'translateX(0px)';
  snapshot.style.opacity = '1';
  document.body.appendChild(snapshot);

  win[META_KEY] = {
    createdAt: Date.now(),
    direction,
    targetPath,
  };
}

export function consumeWebRouteTransition(targetPath: string): WebRouteTransitionMeta | null {
  const win = getWindowObject();
  if (!win) {
    return null;
  }

  const meta = win[META_KEY];
  if (!meta) {
    return null;
  }

  const isExpired = Date.now() - meta.createdAt > MAX_META_AGE_MS;
  if (isExpired || meta.targetPath !== targetPath) {
    if (isExpired) {
      delete win[META_KEY];
    }
    return null;
  }

  delete win[META_KEY];
  return meta;
}

export function getWebRouteSnapshot(): HTMLElement | null {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    return null;
  }

  return document.getElementById(SNAPSHOT_ID);
}

export function clearWebRouteTransition() {
  const win = getWindowObject();
  if (win) {
    delete win[META_KEY];
  }

  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    return;
  }

  document.getElementById(SNAPSHOT_ID)?.remove();
}
