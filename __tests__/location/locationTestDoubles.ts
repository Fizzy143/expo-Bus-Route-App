import type { LocationAdapter } from '../../components/locationAdapter';
import type {
  ForegroundPermissionStatus,
  LocationTrackingMode,
  UserLocationSample,
} from '../../components/locationTypes';
import type { LocationRuntime } from '../../components/LocationProvider';

export function createFakeRuntime() {
  let active = true;
  let visible = true;
  const listeners = new Set<() => void>();
  const runtime: LocationRuntime = {
    isActive: () => active,
    isVisible: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    runtime,
    setActive(value: boolean) {
      active = value;
      listeners.forEach((listener) => listener());
    },
    setVisible(value: boolean) {
      visible = value;
      listeners.forEach((listener) => listener());
    },
  };
}

export function createFakeLocationAdapter(initial?: Partial<{
  permission: ForegroundPermissionStatus;
  requestPermission: ForegroundPermissionStatus;
  services: boolean;
  sample: UserLocationSample;
}>) {
  let permission = initial?.permission ?? 'granted';
  let requestPermissionResult = initial?.requestPermission ?? permission;
  let services = initial?.services ?? true;
  let sample = initial?.sample ?? {
    lat: 25.013,
    lon: 121.535,
    accuracy: 20,
    timestamp: 1000,
  };
  const watches: Array<{
    mode: LocationTrackingMode;
    removed: boolean;
    onLocation: (value: UserLocationSample) => void;
    onError: (error: Error) => void;
  }> = [];

  const adapter: LocationAdapter = {
    getPermission: jest.fn(async () => permission),
    requestPermission: jest.fn(async () => {
      permission = requestPermissionResult;
      return requestPermissionResult;
    }),
    hasServices: jest.fn(async () => services),
    getCurrentLocation: jest.fn(async () => sample),
    watchLocation: jest.fn(async (mode, onLocation, onError) => {
      const watch = { mode, removed: false, onLocation, onError };
      watches.push(watch);
      return { remove: () => { watch.removed = true; } };
    }),
  };

  return {
    adapter,
    watches,
    setPermission(value: ForegroundPermissionStatus) { permission = value; },
    setRequestPermission(value: ForegroundPermissionStatus) {
      requestPermissionResult = value;
    },
    setServices(value: boolean) { services = value; },
    setSample(value: UserLocationSample) { sample = value; },
  };
}
