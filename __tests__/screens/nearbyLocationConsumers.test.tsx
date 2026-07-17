import { fireEvent, render } from '@testing-library/react-native';

import RouteScreen from '../../app/route';
import SearchScreen from '../../app/search';

const mockLocationState: {
  location: null | {
    lat: number;
    lon: number;
    accuracy: number;
    timestamp: number;
  };
  status: 'tracking' | 'requesting';
} = {
  location: { lat: 25.013, lon: 121.535, accuracy: 20, timestamp: 1000 },
  status: 'tracking',
};

jest.mock('../../components/LocationProvider', () => ({
  useUserLocation: () => ({ ...mockLocationState }),
}));
const mockCalculateNearbyStops = jest.fn((..._args: unknown[]) => []);
jest.mock('../../components/locationService', () => ({
  ...jest.requireActual('../../components/locationService'),
  calculateNearbyStops: (...args: unknown[]) => mockCalculateNearbyStops(...args),
  getNearbyStopsWithLocation: jest.fn(async () => ({
    success: true,
    location: null,
    stops: [],
  })),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
  usePathname: () => '/route',
}));
jest.mock('../../components/busPlanner', () => ({
  BusPlannerService: class {
    plan = jest.fn(async () => []);
  },
}));
jest.mock('../../components/favoriteRoutes', () => ({
  favoriteRoutesService: {
    isFavorite: jest.fn(async () => false),
    removeRoute: jest.fn(async () => true),
    addRoute: jest.fn(async () => true),
    updateRouteCacheNames: jest.fn(async () => undefined),
  },
}));

beforeEach(() => {
  mockLocationState.location = {
    lat: 25.013,
    lon: 121.535,
    accuracy: 20,
    timestamp: 1000,
  };
  mockLocationState.status = 'tracking';
  mockCalculateNearbyStops.mockClear();
});

it('does not overwrite Search text when shared location changes', async () => {
  const screen = await render(<SearchScreen />);
  expect(mockCalculateNearbyStops).toHaveBeenCalledWith(mockLocationState.location, 800, 10);

  const input = screen.getByPlaceholderText('搜尋站牌');
  await fireEvent.changeText(input, '台北');
  mockLocationState.location = {
    lat: 25.04,
    lon: 121.56,
    accuracy: 20,
    timestamp: 2000,
  };
  await screen.rerender(<SearchScreen />);

  expect(screen.getByDisplayValue('台北')).toBeTruthy();
  expect(mockCalculateNearbyStops).toHaveBeenLastCalledWith(
    mockLocationState.location,
    800,
    10
  );
  await screen.unmount();
});

it('updates Route nearby candidates without replacing a manual query', async () => {
  const screen = await render(<RouteScreen />);
  expect(mockCalculateNearbyStops).toHaveBeenCalledWith(mockLocationState.location, 800, 10);

  await fireEvent.press(screen.getByText('選擇起點站牌'));
  await fireEvent.changeText(screen.getByPlaceholderText('搜尋站牌'), '公車站');
  mockLocationState.location = {
    lat: 25.05,
    lon: 121.57,
    accuracy: 15,
    timestamp: 3000,
  };
  await screen.rerender(<RouteScreen />);

  expect(screen.getByDisplayValue('公車站')).toBeTruthy();
  expect(mockCalculateNearbyStops).toHaveBeenLastCalledWith(
    mockLocationState.location,
    800,
    10
  );
  await screen.unmount();
});
