import { render } from '@testing-library/react-native';

import Layout from '../../app/_layout';

jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');

  return {
    SafeAreaProvider: ({ children }: React.PropsWithChildren) =>
      React.createElement(View, null, children),
  };
});
jest.mock('../../components/LocationProvider', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');

  return {
    LocationProvider: ({ children }: React.PropsWithChildren) =>
      React.createElement(View, { testID: 'location-provider' }, children),
  };
});

it('wraps the router stack in LocationProvider', async () => {
  const screen = await render(<Layout />);
  expect(screen.getByTestId('location-provider')).toBeTruthy();
});
