import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function Layout() {
  // 在 Web 上添加全局 CSS 動畫
  useEffect(() => {
    if (Platform.OS === 'web') {
      const style = document.createElement('style');
      style.textContent = `
        /* 頁面切換動畫 */
        #root > div {
          transition: opacity 0.2s ease-in-out;
        }
        
        /* 確保動畫應用到所有路由容器 */
        [data-expo-router-container] {
          animation: fadeIn 0.2s ease-in-out;
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
      `;
      document.head.appendChild(style);
      return () => {
        document.head.removeChild(style);
      };
    }
  }, []);

  return (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          animationDuration: 200,
          // 為手機裝置配置內容樣式，預留狀態欄空間
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
