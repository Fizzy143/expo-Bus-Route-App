import { Stack, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function Layout() {
  const pathname = usePathname();

  // Add web-only route transitions tuned for mobile PWA usage.
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    const style = document.createElement('style');
    style.textContent = `
      #root > div {
        background: #152021;
      }

      [data-expo-router-container] {
        will-change: opacity, transform;
        transform-origin: center center;
      }

      [data-expo-router-container].route-transition-enter {
        animation: routeSlideIn 0.42s cubic-bezier(0.22, 1, 0.36, 1);
      }

      @keyframes routeSlideIn {
        from {
          opacity: 0.35;
          transform: translate3d(72px, 0, 0) scale(0.985);
        }
        to {
          opacity: 1;
          transform: translate3d(0, 0, 0) scale(1);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        [data-expo-router-container].route-transition-enter {
          animation-duration: 0.01ms;
        }
      }
    `;

    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    const container = document.querySelector('[data-expo-router-container]');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    container.classList.remove('route-transition-enter');
    void container.offsetWidth;
    container.classList.add('route-transition-enter');

    const handleAnimationEnd = () => {
      container.classList.remove('route-transition-enter');
    };

    container.addEventListener('animationend', handleAnimationEnd);
    return () => {
      container.removeEventListener('animationend', handleAnimationEnd);
      container.classList.remove('route-transition-enter');
    };
  }, [pathname]);

  return (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          animationDuration: 420,
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
    </SafeAreaProvider>
  );
}
