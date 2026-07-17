import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LocationProvider } from '../components/LocationProvider';

const appTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#152021',
    card: '#152021',
  },
};

export default function Layout() {
  return (
    <SafeAreaProvider>
      <LocationProvider>
        <ThemeProvider value={appTheme}>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: 'none',
              contentStyle: {
                backgroundColor: '#152021',
              },
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="search" />
            <Stack.Screen name="route" />
            <Stack.Screen name="bus-route" />
            <Stack.Screen name="stop" />
            <Stack.Screen name="map" />
          </Stack>
        </ThemeProvider>
      </LocationProvider>
    </SafeAreaProvider>
  );
}
