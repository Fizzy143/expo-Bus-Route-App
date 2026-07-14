import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { VERSION_METADATA } from '../constants/version';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface VersionPayload {
  appVersion: string;
  buildId: string;
  generatedAt: string;
}

async function unregisterDevServiceWorkers() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ('caches' in window) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)));
  }
}

function postSkipWaiting(registration: ServiceWorkerRegistration | null) {
  registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

export default function ServiceWorkerRegister() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateDetail, setUpdateDetail] = useState('重新整理後就會切到最新版。');

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

    const handleControllerChange = () => {
      window.location.reload();
    };

    const handleWaitingWorker = (registration: ServiceWorkerRegistration) => {
      registrationRef.current = registration;
      setUpdateDetail('重新整理後就會切到最新版。');
      setUpdateReady(true);
    };

    const watchInstallingWorker = (registration: ServiceWorkerRegistration) => {
      const newWorker = registration.installing;
      if (!newWorker) {
        return;
      }

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          handleWaitingWorker(registration);
        }
      });
    };

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

        registrationRef.current = registration;

        if (registration.waiting) {
          handleWaitingWorker(registration);
        }

        registration.addEventListener('updatefound', () => {
          watchInstallingWorker(registration);
        });

        const checkForUpdates = () => {
          void registration.update().catch((error) => {
            console.error('[SW] Update check failed:', error);
          });
        };

        const checkVersionFile = async () => {
          try {
            const response = await fetch(`/version.json?ts=${Date.now()}`, {
              cache: 'no-store',
            });

            if (!response.ok) {
              return;
            }

            const remoteVersion = (await response.json()) as VersionPayload;
            if (
              remoteVersion.appVersion !== VERSION_METADATA.appVersion ||
              remoteVersion.buildId !== VERSION_METADATA.buildId
            ) {
              setUpdateDetail(
                `目前版本 ${VERSION_METADATA.appVersion}，伺服器已有較新版本可更新。`
              );
              setUpdateReady(true);
            }
          } catch (error) {
            console.error('[SW] Version check failed:', error);
          }
        };

        checkForUpdates();
        void checkVersionFile();

        const intervalId = window.setInterval(() => {
          checkForUpdates();
          void checkVersionFile();
        }, UPDATE_CHECK_INTERVAL_MS);

        const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
            checkForUpdates();
            void checkVersionFile();
          }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
          window.clearInterval(intervalId);
          document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
      } catch (error) {
        console.error('[SW] Registration failed:', error);
        return undefined;
      }
    };

    let cleanupRegistrationListeners: (() => void) | undefined;
    let cancelled = false;

    const startRegistration = async () => {
      const cleanup = await registerSW();
      if (!cancelled) {
        cleanupRegistrationListeners = cleanup;
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      void startRegistration();
    } else {
      const onLoad = () => {
        void startRegistration();
      };
      window.addEventListener('load', onLoad, { once: true });
    }

    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      cleanupRegistrationListeners?.();
    };
  }, []);

  const handleApplyUpdate = async () => {
    setIsUpdating(true);
    const registration = registrationRef.current;

    if (registration?.waiting) {
      postSkipWaiting(registration);
      return;
    }

    try {
      await registration?.update();
    } catch (error) {
      console.error('[SW] Manual update failed:', error);
    }

    window.location.reload();
  };

  if (Platform.OS !== 'web' || !updateReady) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.banner}>
        <View style={styles.textContainer}>
          <Text style={styles.title}>有新版本可用</Text>
          <Text style={styles.description}>
            更新不會清除你儲存在本機的常用路線，{updateDetail}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.button, isUpdating && styles.buttonDisabled]}
          onPress={handleApplyUpdate}
          disabled={isUpdating}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>{isUpdating ? '更新中...' : '立即更新'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'fixed' as any,
    left: 16,
    right: 16,
    bottom: 88,
    zIndex: 1100,
  },
  banner: {
    backgroundColor: '#E8F1F1',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    boxShadow: '0 10px 24px rgba(0, 0, 0, 0.18)',
  },
  textContainer: {
    flex: 1,
    gap: 4,
  },
  title: {
    color: '#152021',
    fontSize: 15,
    fontWeight: '800',
  },
  description: {
    color: '#314243',
    fontSize: 12,
    lineHeight: 18,
  },
  button: {
    backgroundColor: '#152021',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
});
