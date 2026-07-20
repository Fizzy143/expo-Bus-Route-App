import { readFileSync } from 'fs';
import { join } from 'path';
import { render } from '@testing-library/react-native';

jest.mock('../../components/LocationProvider', () => ({
  useUserLocation: () => ({
    location: null,
    status: 'degraded',
    permissionStatus: 'granted',
  }),
}));
jest.mock('../../components/locationService', () => ({
  calculateNearbyStops: jest.fn(() => []),
  formatDistance: jest.fn(() => '0m'),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
}));

const MapScreen = jest.requireActual('../../app/map.tsx').default;

it('shows retry feedback instead of an empty nearby list on web', async () => {
  const screen = await render(<MapScreen />);

  expect(screen.getByText('定位訊號不穩定，正在持續嘗試…')).toBeTruthy();
  expect(screen.queryByText('附近沒有找到站牌')).toBeNull();
});

it('keeps the degraded retry feedback in the native map source', () => {
  const source = readFileSync(join(__dirname, '../../app/map.native.tsx'), 'utf8');

  expect(source).toContain('定位訊號不穩定，正在持續嘗試…');
});
