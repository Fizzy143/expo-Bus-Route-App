import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';

import {
  expoLocationAdapter,
  type LocationAdapter,
  type LocationSubscription,
} from './locationAdapter';
import { acceptLocationSample, createLatestThrottle } from './locationPolicy';
import {
  TRACKING_PROFILE,
  type ForegroundPermissionStatus,
  type LocationSnapshot,
  type LocationStatus,
  type LocationTrackingMode,
  type UserLocationSample,
} from './locationTypes';

export interface LocationRuntime {
  isActive(): boolean;
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface LocationPermissionSession {
  resolve(adapter: LocationAdapter): Promise<ForegroundPermissionStatus>;
}

export interface UserLocationContextValue {
  status: LocationStatus;
  location: UserLocationSample | null;
  permissionStatus: ForegroundPermissionStatus;
  trackingMode: LocationTrackingMode;
  error: string | null;
  setTrackingMode(mode: LocationTrackingMode): void;
  refresh(): Promise<void>;
}

const isDocumentVisible = () =>
  Platform.OS !== 'web' ||
  typeof document === 'undefined' ||
  document.visibilityState === 'visible';

export const defaultLocationRuntime: LocationRuntime = {
  isActive: () => AppState.currentState === 'active',
  isVisible: isDocumentVisible,
  subscribe(listener) {
    const appStateSubscription = AppState.addEventListener('change', listener);
    const visibilityListener = () => listener();

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibilityListener);
    }

    return () => {
      appStateSubscription.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibilityListener);
      }
    };
  },
};

export function createLocationPermissionSession(): LocationPermissionSession {
  let requestStarted = false;
  let requestPromise: Promise<ForegroundPermissionStatus> | null = null;

  return {
    async resolve(adapter) {
      const current = await adapter.getPermission();
      if (current !== 'undetermined') return current;

      if (!requestStarted) {
        requestStarted = true;
        requestPromise = adapter.requestPermission();
      }

      return requestPromise!;
    },
  };
}

const appLocationPermissionSession = createLocationPermissionSession();
const LocationContext = createContext<UserLocationContextValue | undefined>(undefined);
const RETRY_DELAYS = [1000, 2000, 5000] as const;

type LocationProviderProps = React.PropsWithChildren<{
  adapter?: LocationAdapter;
  runtime?: LocationRuntime;
  permissionSession?: LocationPermissionSession;
}>;

export function LocationProvider({
  children,
  adapter = expoLocationAdapter,
  runtime = defaultLocationRuntime,
  permissionSession = appLocationPermissionSession,
}: LocationProviderProps) {
  const [status, setStatus] = useState<LocationStatus>('requesting');
  const [permissionStatus, setPermissionStatus] =
    useState<ForegroundPermissionStatus>('undetermined');
  const [trackingMode, setTrackingMode] = useState<LocationTrackingMode>('standard');
  const [error, setError] = useState<string | null>(null);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<LocationSnapshot>({
    location: null,
    hasReliableLocation: false,
  });

  const snapshotRef = useRef(snapshot);
  const generationRef = useRef(0);
  const subscriptionRef = useRef<LocationSubscription | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleRef = useRef<
    ReturnType<typeof createLatestThrottle<UserLocationSample>> | null
  >(null);

  const applySample = useCallback((candidate: UserLocationSample) => {
    const decision = acceptLocationSample(snapshotRef.current, candidate);
    if (!decision.accepted) return;

    snapshotRef.current = decision.snapshot;
    setSnapshot(decision.snapshot);
    setStatus(decision.quality === 'reliable' ? 'tracking' : 'degraded');
  }, []);

  const cleanupAttempt = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    throttleRef.current?.dispose();
    throttleRef.current = null;

    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  useEffect(
    () => runtime.subscribe(() => setRuntimeRevision((value) => value + 1)),
    [runtime]
  );

  useEffect(() => {
    let disposed = false;

    const startAttempt = async (attempt: number): Promise<void> => {
      cleanupAttempt();
      const generation = ++generationRef.current;

      if (!runtime.isActive() || !runtime.isVisible()) {
        setStatus('paused');
        return;
      }

      const isCurrentAttempt = () =>
        !disposed && generation === generationRef.current;

      const retry = (failure: unknown) => {
        if (!isCurrentAttempt()) return;

        cleanupAttempt();
        setError(failure instanceof Error ? failure.message : String(failure));
        setStatus('degraded');

        const delay = RETRY_DELAYS[attempt];
        if (delay !== undefined) {
          retryTimerRef.current = setTimeout(
            () => void startAttempt(attempt + 1),
            delay
          );
        }
      };

      try {
        setStatus('requesting');
        setError(null);

        const permission = await permissionSession.resolve(adapter);
        if (!isCurrentAttempt()) return;
        setPermissionStatus(permission);

        if (permission === 'unavailable') {
          setStatus('unavailable');
          return;
        }
        if (permission !== 'granted') {
          setStatus('denied');
          return;
        }

        const hasServices = await adapter.hasServices();
        if (!isCurrentAttempt()) return;
        if (!hasServices) {
          setStatus('unavailable');
          return;
        }

        const current = await adapter.getCurrentLocation(trackingMode);
        if (!isCurrentAttempt()) return;
        applySample(current);

        if (trackingMode === 'trip') {
          throttleRef.current = createLatestThrottle(
            TRACKING_PROFILE.trip.throttleMs,
            applySample
          );
        }

        const onLocation = (candidate: UserLocationSample) => {
          if (!isCurrentAttempt()) return;
          if (trackingMode === 'trip') throttleRef.current?.push(candidate);
          else applySample(candidate);
        };

        const subscription = await adapter.watchLocation(
          trackingMode,
          onLocation,
          retry
        );
        if (!isCurrentAttempt()) {
          subscription.remove();
          return;
        }

        subscriptionRef.current = subscription;
        setError(null);
        setStatus(snapshotRef.current.hasReliableLocation ? 'tracking' : 'degraded');
      } catch (failure) {
        retry(failure);
      }
    };

    void startAttempt(0);

    return () => {
      disposed = true;
      generationRef.current += 1;
      cleanupAttempt();
    };
  }, [
    adapter,
    applySample,
    cleanupAttempt,
    permissionSession,
    refreshRevision,
    runtime,
    runtimeRevision,
    trackingMode,
  ]);

  const refresh = useCallback(async () => {
    setRefreshRevision((value) => value + 1);
  }, []);

  const value = useMemo<UserLocationContextValue>(
    () => ({
      status,
      location: snapshot.location,
      permissionStatus,
      trackingMode,
      error,
      setTrackingMode,
      refresh,
    }),
    [error, permissionStatus, refresh, snapshot.location, status, trackingMode]
  );

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useUserLocation() {
  const value = useContext(LocationContext);
  if (!value) throw new Error('useUserLocation must be used inside LocationProvider');
  return value;
}
