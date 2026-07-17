import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Animated } from 'react-native';

import HomeScreen from '../../app/index';
import type { FavoriteRoute } from '../../components/favoriteRoutes';

const mockPush = jest.fn();
const mockGetRepresentativeSids = jest.fn(() => ['fallback-sid']);
const mockFetchBusesAtSid = jest.fn(async () => []);

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    clear: jest.fn(async () => undefined),
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
}));
jest.mock('react-native-pager-view', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ children }: React.PropsWithChildren) =>
      React.createElement(View, null, children),
  };
});
jest.mock('../../components/busPlanner', () => ({
  BusPlannerService: class {
    getRepresentativeSids = mockGetRepresentativeSids;
    fetchBusesAtSid = mockFetchBusesAtSid;
    prefetchRouteStopArrivals = jest.fn(async () => undefined);
    plan = jest.fn(async () => []);
  },
}));
jest.mock('../../components/favoriteRoutes', () => ({
  favoriteRoutesService: {
    getAllRoutes: jest.fn(async () => []),
    updateRouteCacheInfo: jest.fn(async () => undefined),
  },
}));
jest.mock('../../components/LocationProvider', () => ({
  useUserLocation: () => ({ location: null }),
}));
jest.mock('../../components/locationService', () => ({
  loadAllStops: () => [],
}));
jest.mock('../../hooks/useStableNearestStop', () => ({
  useStableNearestStop: () => null,
}));
jest.mock('../../components/NotificationSettings', () => () => null);
jest.mock('../../components/InstallPWA', () => () => null);
jest.mock('../../components/ServiceWorkerRegister', () => () => null);
jest.mock('../../components/web-route-transition', () => ({
  beginWebRouteTransition: jest.fn(),
}));
jest.mock('../../components/WebRouteTransitionView', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ children }: React.PropsWithChildren) =>
      React.createElement(View, null, children),
  };
});

const { favoriteRoutesService: mockFavoriteRoutesService } = jest.requireMock(
  '../../components/favoriteRoutes'
) as {
  favoriteRoutesService: {
    getAllRoutes: jest.Mock<Promise<FavoriteRoute[]>, [boolean?]>;
  };
};
const mockGetAllRoutes = mockFavoriteRoutesService.getAllRoutes;

jest.spyOn(Animated, 'timing').mockImplementation(() => ({
  start: jest.fn(),
  stop: jest.fn(),
  reset: jest.fn(),
}) as unknown as Animated.CompositeAnimation);

beforeEach(() => {
  mockPush.mockClear();
  mockGetAllRoutes.mockReset();
  mockGetAllRoutes.mockResolvedValue([]);
  mockGetRepresentativeSids.mockClear();
  mockFetchBusesAtSid.mockClear();
});

it('keeps station search but shows only the add-favorite empty state', async () => {
  const screen = await render(<HomeScreen />);

  expect(await screen.findByText('尚未新增常用路線')).toBeTruthy();
  expect(screen.getByText('新增經常搭乘的路線，即可在首頁快速查看公車動態。')).toBeTruthy();
  expect(screen.getByPlaceholderText('搜尋站牌')).toBeTruthy();
  expect(screen.queryByText(/^更新時間：/)).toBeNull();

  await waitFor(() => {
    expect(mockGetAllRoutes).toHaveBeenCalled();
    expect(mockGetRepresentativeSids).not.toHaveBeenCalled();
    expect(mockFetchBusesAtSid).not.toHaveBeenCalled();
  });

  await fireEvent.press(screen.getByText('新增常用路線'));
  expect(mockPush).toHaveBeenCalledWith('/route');

  await screen.unmount();
});

it('does not flash the empty state before favorites finish loading', async () => {
  let resolveRoutes: (routes: FavoriteRoute[]) => void = () => undefined;
  mockGetAllRoutes.mockImplementationOnce(
    () => new Promise<FavoriteRoute[]>(resolve => {
      resolveRoutes = resolve;
    })
  );

  const screen = await render(<HomeScreen />);
  await waitFor(() => expect(mockGetAllRoutes).toHaveBeenCalled());
  expect(screen.queryByText('尚未新增常用路線')).toBeNull();

  await act(async () => resolveRoutes([]));
  expect(await screen.findByText('尚未新增常用路線')).toBeTruthy();
  await screen.unmount();
});

it('keeps favorite content and clears its refresh interval on unmount', async () => {
  const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
  mockGetAllRoutes.mockResolvedValue([{
    id: 'A-B',
    fromStop: 'A',
    toStop: 'B',
    addedAt: 1000,
    useCount: 1,
    pinned: false,
  }]);

  const screen = await render(<HomeScreen />);
  expect(await screen.findByText('常用路線')).toBeTruthy();
  expect(screen.queryByText('尚未新增常用路線')).toBeNull();

  await screen.unmount();
  expect(clearIntervalSpy).toHaveBeenCalled();
  clearIntervalSpy.mockRestore();
});

it('does not start favorite refresh after pending storage hydration resolves post-unmount', async () => {
  let resolveRoutes: (routes: FavoriteRoute[]) => void = () => undefined;
  mockGetAllRoutes.mockImplementationOnce(
    () => new Promise<FavoriteRoute[]>(resolve => {
      resolveRoutes = resolve;
    })
  );
  const setIntervalSpy = jest.spyOn(global, 'setInterval');

  try {
    const screen = await render(<HomeScreen />);
    await waitFor(() => expect(mockGetAllRoutes).toHaveBeenCalled());
    await screen.unmount();
    const intervalCallCountAfterUnmount = setIntervalSpy.mock.calls.length;

    await act(async () => {
      resolveRoutes([{
        id: 'A-B',
        fromStop: 'A',
        toStop: 'B',
        addedAt: 1000,
        useCount: 1,
        pinned: false,
      }]);
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(intervalCallCountAfterUnmount);
  } finally {
    setIntervalSpy.mock.results.forEach(result => {
      if (result.type === 'return') {
        clearInterval(result.value as ReturnType<typeof setInterval>);
      }
    });
    setIntervalSpy.mockRestore();
  }
});

it('keeps Home source free of location and generic stop-arrival dependencies', () => {
  const homeSource = readFileSync(join(__dirname, '../../app/index.tsx'), 'utf8');
  const forbiddenSymbols = [
    'HOME_STOP_CANDIDATES',
    'homeStopSelection',
    'useUserLocation',
    'useStableNearestStop',
    'expo-location',
    'findNearestStop',
    'loadAllStops',
    'getRepresentativeSids',
    'fetchBusesAtSid',
    '@recent_stop',
    '捷運公館站',
  ];

  forbiddenSymbols.forEach(symbol => {
    expect(homeSource).not.toContain(symbol);
  });
});
