import { useEffect } from 'react';
import { Platform } from 'react-native';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

async function unregisterDevServiceWorkers() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map(registration => registration.unregister()));

  if ('caches' in window) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map(cacheKey => caches.delete(cacheKey)));
  }
}

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }

    if (!('serviceWorker' in navigator)) {
      console.log('[SW] Service Worker is not supported in this browser.');
      return;
    }

    const hostname = window.location.hostname;
    const isLocalhost = LOCAL_HOSTS.has(hostname);

    const registerSW = async () => {
      try {
        if (isLocalhost) {
          await unregisterDevServiceWorkers();
          console.log('[SW] Disabled for localhost development.');
          return;
        }

        const registration = await navigator.serviceWorker.register('/service-worker.js', {
          scope: '/',
        });

        console.log('[SW] Registered with scope:', registration.scope);

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) {
            return;
          }

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] New content is available; refresh to update.');
            }
          });
        });
      } catch (error) {
        console.error('[SW] Registration failed:', error);
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      void registerSW();
      return;
    }

    const onLoad = () => {
      void registerSW();
    };

    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);

  return null;
}
