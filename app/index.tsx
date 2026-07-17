import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  TouchableOpacity,
  View,
} from 'react-native';
import PagerView from 'react-native-pager-view';
// 假設 BusPlannerService 放在 services 資料夾，請依實際位置調整
import { BusPlannerService } from '../components/busPlanner';
import { FavoriteRoute, favoriteRoutesService } from '../components/favoriteRoutes';
import HomeEmptyState from '../components/HomeEmptyState';
import InstallPWA from '../components/InstallPWA';
import NotificationSettings from '../components/NotificationSettings';
import ServiceWorkerRegister from '../components/ServiceWorkerRegister';
import { beginWebRouteTransition } from '../components/web-route-transition';
import WebRouteTransitionView from '../components/WebRouteTransitionView';
import { compareArrivals } from '../utils/routeSorter';

// 定義 UI 用的介面 (配合新 API 的回傳結構進行適配)
interface UIArrival {
  rid?: string;
  route: string;
  routeName?: string;
  preferredDirection?: string;
  direction?: string; // 加入方向資訊（選填，因為有些情況可能沒有）
  estimatedTime: string;
  key: string;
}

interface FavoriteRouteCacheInfo {
  routeName: string;
  rid: string;
  direction: string;
}

export default function StopScreen() {
  const router = useRouter();
  const pageTransitionRef = useRef<HTMLElement | null>(null);
  const AUTO_REFRESH_MS = 10000;

  // 使用新版 Service
  const plannerRef = useRef(new BusPlannerService());
  const [serviceReady, setServiceReady] = useState(false);
  const favoriteMountedRef = useRef(false);
  const favoriteIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const favoriteRefreshInFlightRef = useRef(false);

  // 常用路線狀態
  const [favoriteRoutes, setFavoriteRoutes] = useState<FavoriteRoute[]>([]);
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const selectedRouteIndexRef = useRef(0);
  const favoriteRoutesRef = useRef<FavoriteRoute[]>([]);
  
  // 滑動相關 ref
  const pagerRef = useRef<PagerView>(null);
  const routeButtonScrollRef = useRef<ScrollView>(null);
  const [allFavoriteArrivals, setAllFavoriteArrivals] = useState<UIArrival[][]>([]);

  useEffect(() => {
    favoriteMountedRef.current = true;

    return () => {
      favoriteMountedRef.current = false;
      if (favoriteIntervalRef.current) {
        clearInterval(favoriteIntervalRef.current);
        favoriteIntervalRef.current = null;
      }
    };
  }, []);
  
  // 長按選單狀態
  const [menuVisible, setMenuVisible] = useState<boolean>(false);
  const [selectedRoute, setSelectedRoute] = useState<FavoriteRoute | null>(null);

  // 側欄狀態
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(false);
  const sidebarAnimation = useRef(new Animated.Value(0)).current;
  
  // 通知設定 Modal 狀態
  const [notificationModalVisible, setNotificationModalVisible] = useState<boolean>(false);
  
  // 檢測是否為手機裝置
  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(false);
  
  useEffect(() => {
    // 檢測裝置類型
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      setIsMobileDevice(true);
    } else if (Platform.OS === 'web') {
      // Web 平台檢測螢幕尺寸
      const checkMobile = () => {
        const width = Dimensions.get('window').width;
        setIsMobileDevice(width < 768);
      };
      checkMobile();
      const subscription = Dimensions.addEventListener('change', checkMobile);
      return () => subscription?.remove();
    }
  }, []);

  // 側欄動畫效果
  useEffect(() => {
    Animated.timing(sidebarAnimation, {
      toValue: sidebarVisible ? 1 : 0,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [sidebarVisible, sidebarAnimation]);

  const sidebarWidth = sidebarAnimation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '60%'],
  });

  const mainContentTranslate = sidebarAnimation.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 250],
  });
  const openRouteDetails = (
    routeName?: string,
    preferredRid?: string,
    preferredDirection?: string
  ) => {
    const normalizedRouteName = routeName?.trim();
    if (!normalizedRouteName || normalizedRouteName === '載入中') {
      return;
    }

    beginWebRouteTransition(pageTransitionRef.current, '/bus-route', 'forward');
    router.push({
      pathname: '/bus-route' as any,
      params: {
        routeName: normalizedRouteName,
        preferredRid: preferredRid?.trim() || undefined,
        preferredDirection: preferredDirection?.trim() || undefined,
      },
    });
  };

  const openRoutePlanner = () => {
    beginWebRouteTransition(pageTransitionRef.current, '/route', 'forward');
    router.push('/route');
  };

  useEffect(() => setServiceReady(true), []);

  // 當 serviceReady 變為 true 時，立即載入常用路線
  useEffect(() => {
    if (serviceReady) {
      loadFavoriteRoutes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 serviceReady 變 true 時載入；loadFavoriteRoutes 唯一 reactive 依賴就是 serviceReady（已列）
  }, [serviceReady]);

  // 當頁面重新聚焦時，重新載入常用路線
  useFocusEffect(
    useCallback(() => {
      if (serviceReady) {
        loadFavoriteRoutes();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 聚焦時重載常用路線；loadFavoriteRoutes 唯一 reactive 依賴就是 serviceReady（已列）
    }, [serviceReady])
  );

  useEffect(() => {
    selectedRouteIndexRef.current = selectedRouteIndex;
  }, [selectedRouteIndex]);

  useEffect(() => {
    favoriteRoutesRef.current = favoriteRoutes;
  }, [favoriteRoutes]);

  // 處理 PagerView 頁面變化（滑動切換）
  const handlePageSelected = (e: any) => {
    const newIndex = e.nativeEvent.position;
    if (newIndex !== selectedRouteIndex && newIndex >= 0 && newIndex < favoriteRoutes.length) {
      selectedRouteIndexRef.current = newIndex;
      setSelectedRouteIndex(newIndex);
      scrollRouteButtonToCenter(newIndex);
      if (allFavoriteArrivals[newIndex]) {
        void prefetchFavoriteRouteDetails(allFavoriteArrivals[newIndex]);
      }
    }
  };

  // 將選中的路線按鈕滾動到可視區域中央
  const scrollRouteButtonToCenter = (index: number) => {
    if (routeButtonScrollRef.current) {
      const buttonWidth = 150; // 估計按鈕寬度
      const screenWidth = Dimensions.get('window').width;
      const scrollX = Math.max(0, (index * buttonWidth) - (screenWidth / 2) + (buttonWidth / 2));
      routeButtonScrollRef.current.scrollTo({ x: scrollX, animated: true });
    }
  };

  const buildCachedFavoriteArrivals = (route: FavoriteRoute): UIArrival[] => {
    const cachedRouteInfo = route.cachedRouteInfo || [];

    if (cachedRouteInfo.length > 0) {
      const seen = new Set<string>();
      const arrivals: UIArrival[] = [];

      cachedRouteInfo.forEach((info, index) => {
        const routeName = info.routeName?.trim();
        if (!routeName) {
          return;
        }

        const rid = info.rid?.trim() || undefined;
        const direction = info.direction?.trim() || '';
        const key = `${routeName}|${rid || ''}|${direction}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);

        arrivals.push({
          rid,
          route: routeName,
          routeName,
          preferredDirection: direction,
          direction,
          estimatedTime: '載入中...',
          key: `cache-${route.id}-${rid || routeName}-${direction || index}`,
        });
      });

      if (arrivals.length > 0) {
        return arrivals;
      }
    }

    if (route.cachedRouteNames && route.cachedRouteNames.length > 0) {
      return route.cachedRouteNames.map((routeName, index) => ({
        route: routeName,
        routeName,
        estimatedTime: '載入中...',
        key: `cache-${route.id}-${routeName}-${index}`,
      }));
    }

    return [{
      route: '載入中',
      estimatedTime: '...',
      key: `loading-${route.id}`,
    }];
  };

  const getRouteInfoSignature = (routeInfo: FavoriteRouteCacheInfo[] = []) =>
    routeInfo.map(info => `${info.routeName}|${info.rid}|${info.direction}`).join('\n');

  const buildRouteInfoFromPlans = (plans: any[]): FavoriteRouteCacheInfo[] => {
    const uniqueRouteMap = new Map<string, FavoriteRouteCacheInfo>();

    plans.forEach(bus => {
      const routeName = String(bus.routeName || '').trim();
      const rid = String(bus.rid || '').trim();
      const direction = String(bus.directionText || '').trim();
      if (!routeName) {
        return;
      }

      const key = `${routeName}|${rid}|${direction}`;
      if (!uniqueRouteMap.has(key)) {
        uniqueRouteMap.set(key, { routeName, rid, direction });
      }
    });

    return Array.from(uniqueRouteMap.values()).sort((a, b) => {
      const routeCompare = a.routeName.localeCompare(b.routeName, 'zh-TW');
      if (routeCompare !== 0) return routeCompare;

      const ridCompare = a.rid.localeCompare(b.rid, 'zh-TW');
      if (ridCompare !== 0) return ridCompare;

      return a.direction.localeCompare(b.direction, 'zh-TW');
    });
  };

  const updateFavoriteRouteCache = async (
    route: FavoriteRoute,
    routeInfo: FavoriteRouteCacheInfo[]
  ) => {
    if (routeInfo.length === 0) {
      return;
    }

    if (getRouteInfoSignature(route.cachedRouteInfo || []) === getRouteInfoSignature(routeInfo)) {
      return;
    }

    await favoriteRoutesService.updateRouteCacheInfo(route.fromStop, route.toStop, routeInfo);
  };

  const prefetchFavoriteRouteDetails = async (arrivals: UIArrival[]) => {
    if (!serviceReady || arrivals.length === 0) {
      return;
    }

    const seen = new Set<string>();
    const tasks: Promise<unknown>[] = [];

    arrivals.forEach(item => {
      const routeName = item.routeName?.trim();
      if (!routeName || routeName === '載入中') {
        return;
      }

      const rid = item.rid?.trim() || undefined;
      const directionHint = (item.preferredDirection || item.direction || '').trim() || undefined;
      const key = `${routeName}|${rid || ''}|${directionHint || ''}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      tasks.push(
        plannerRef.current
          .prefetchRouteStopArrivals(routeName, rid, directionHint)
          .catch(error => {
            console.warn('[Index] Failed to prefetch route detail:', routeName, error);
          })
      );
    });

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  };

  const keepOldOrApplyFavoriteArrivals = (
    previous: UIArrival[][],
    routes: FavoriteRoute[],
    nextArrivals: UIArrival[][]
  ): UIArrival[][] => {
    return routes.map((route, index) => {
      const next = nextArrivals[index];
      if (next && next.length > 0) {
        return next;
      }

      const existing = previous[index];
      if (existing && existing.length > 0) {
        return existing;
      }

      return buildCachedFavoriteArrivals(route);
    });
  };

  const syncFavoriteRoutes = (routes: FavoriteRoute[]) => {
    favoriteRoutesRef.current = routes;
    setFavoriteRoutes(routes);
  };

  const clampSelectedRouteIndex = (routeCount: number): number => {
    if (routeCount <= 0) {
      selectedRouteIndexRef.current = 0;
      setSelectedRouteIndex(0);
      return 0;
    }

    const nextIndex =
      selectedRouteIndexRef.current >= 0 && selectedRouteIndexRef.current < routeCount
        ? selectedRouteIndexRef.current
        : 0;
    selectedRouteIndexRef.current = nextIndex;
    setSelectedRouteIndex(nextIndex);
    return nextIndex;
  };

  const seedFavoriteArrivalsFromCache = (routes: FavoriteRoute[], selectedIndex: number) => {
    const previousRoutes = favoriteRoutesRef.current;

    setAllFavoriteArrivals(previous => {
      const previousByRouteId = new Map<string, UIArrival[]>();
      previousRoutes.forEach((route, index) => {
        const existing = previous[index];
        if (existing && existing.length > 0) {
          previousByRouteId.set(route.id, existing);
        }
      });

      return routes.map(route => previousByRouteId.get(route.id) || buildCachedFavoriteArrivals(route));
    });

    void prefetchFavoriteRouteDetails(buildCachedFavoriteArrivals(routes[selectedIndex]));
  };

  const startFavoriteAutoRefresh = () => {
    if (!favoriteMountedRef.current) return;
    if (favoriteIntervalRef.current) clearInterval(favoriteIntervalRef.current);

    favoriteIntervalRef.current = setInterval(async () => {
      try {
        console.log('🔄 自動刷新常用路線動態...');
        const currentRoutes = await favoriteRoutesService.getAllRoutes(true);
        if (!favoriteMountedRef.current) return;

        syncFavoriteRoutes(currentRoutes);

        if (currentRoutes.length > 0) {
          clampSelectedRouteIndex(currentRoutes.length);
          loadAllFavoriteRoutesArrivals(currentRoutes, true);
        } else {
          setAllFavoriteArrivals([]);
          if (favoriteIntervalRef.current) clearInterval(favoriteIntervalRef.current);
        }
      } catch (error) {
        console.error('自動刷新常用路線失敗:', error);
      }
    }, AUTO_REFRESH_MS);
  };

  // 載入常用路線
  const loadFavoriteRoutes = async () => {
    try {
      const routes = await favoriteRoutesService.getAllRoutes(true);
      if (!favoriteMountedRef.current) return;

      console.log('已載入常用路線:', routes.length, '條');

      if (routes.length > 0) {
        const selectedIndex = clampSelectedRouteIndex(routes.length);
        seedFavoriteArrivalsFromCache(routes, selectedIndex);
        syncFavoriteRoutes(routes);
        loadAllFavoriteRoutesArrivals(routes, false);
        startFavoriteAutoRefresh();
      } else {
        syncFavoriteRoutes([]);
        setAllFavoriteArrivals([]);
        if (favoriteIntervalRef.current) clearInterval(favoriteIntervalRef.current);
      }
    } catch (error) {
      console.error('載入常用路線失敗:', error);
    } finally {
      if (favoriteMountedRef.current) {
        setFavoritesLoaded(true);
      }
    }
  };

  // 預載所有常用路線的公車動態（自動更新時保留舊資料直到新資料完成）
  const loadAllFavoriteRoutesArrivals = async (routes: FavoriteRoute[], isAutoRefresh = false) => {
    if (!favoriteMountedRef.current) return;
    if (isAutoRefresh && favoriteRefreshInFlightRef.current) {
      console.log('🔄 [自動更新] 上一輪尚未完成，略過本次更新');
      return;
    }

    favoriteRefreshInFlightRef.current = true;

    try {
      if (isAutoRefresh) {
        console.log('🔄 [自動更新] 開始更新', routes.length, '條路線');
        const allNewArrivals: UIArrival[][] = [];
        for (let i = 0; i < routes.length; i++) {
          allNewArrivals[i] = await fetchSingleRouteArrivals(routes[i], i);
          if (!favoriteMountedRef.current) return;
        }

        setAllFavoriteArrivals(previous =>
          keepOldOrApplyFavoriteArrivals(previous, routes, allNewArrivals)
        );

        const selectedIndex = selectedRouteIndexRef.current;
        const selectedArrivals = allNewArrivals[selectedIndex];
        if (selectedArrivals && selectedArrivals.length > 0) {
          void prefetchFavoriteRouteDetails(selectedArrivals);
        }

        console.log('✅ [自動更新] 完成所有更新');
        return;
      }

      console.log('🆕 [Index] 初始載入模式 - 逐條載入路線');
      for (let i = 0; i < routes.length; i++) {
        const arrivals = await fetchSingleRouteArrivals(routes[i], i);
        if (!favoriteMountedRef.current) return;

        const nextArrivals: UIArrival[][] = [];
        nextArrivals[i] = arrivals;

        setAllFavoriteArrivals(previous =>
          keepOldOrApplyFavoriteArrivals(previous, routes, nextArrivals)
        );

        if (arrivals.length > 0 && i === selectedRouteIndexRef.current) {
          void prefetchFavoriteRouteDetails(arrivals);
        }
      }
    } catch (error) {
      console.error('預載所有路線動態失敗:', error);
    } finally {
      favoriteRefreshInFlightRef.current = false;
    }
  };

  // 抽取單一路線的公車動態（用於預載）
  const fetchSingleRouteArrivals = async (
    route: FavoriteRoute,
    routeIndex: number
  ): Promise<UIArrival[]> => {
    try {
      if (!serviceReady) {
        return [];
      }

      console.log('Processing route:', route.fromStop, '→', route.toStop);
      const plans = await plannerRef.current.plan(route.fromStop, route.toStop);

      console.log('Plans found:', plans.length);
      if (plans.length === 0) {
        return [];
      }

      await updateFavoriteRouteCache(route, buildRouteInfoFromPlans(plans));

      plans.sort((a, b) => compareArrivals(a, b));
      const favoriteArrivals: UIArrival[] = plans.map((bus, index) => ({
        rid: bus.rid,
        route: bus.routeName,
        routeName: bus.routeName,
        preferredDirection: bus.directionText || '',
        direction: bus.directionText || '',
        estimatedTime: bus.arrivalTimeText || '更新中',
        key: `fav-${route.id}-${bus.rid}-${bus.routeName}-${bus.directionText || index}`,
      }));

      console.log(`Total favorite arrivals for route ${routeIndex}:`, favoriteArrivals.length);
      return favoriteArrivals;
    } catch (error) {
      console.error('抽取路線公車動態失敗:', error);
      return [];
    }
  };

  // 長按路線顯示選單
  const handleLongPress = (route: FavoriteRoute) => {
    setSelectedRoute(route);
    setMenuVisible(true);
  };

  // 重新命名路線
  const handleRename = () => {
    setMenuVisible(false);
    if (!selectedRoute) return;

    if (Platform.OS === 'web') {
      const newName = prompt('輸入新名稱（留空則清除自訂名稱）:', selectedRoute.displayName || '');
      if (newName !== null) {
        const trimmedName = newName.trim();
        favoriteRoutesService.updateRoute(
          selectedRoute.fromStop,
          selectedRoute.toStop,
          { displayName: trimmedName === '' ? undefined : trimmedName }
        ).then(() => {
          loadFavoriteRoutes();
        });
      }
    } else {
      Alert.prompt(
        '重新命名',
        '輸入新名稱（留空則清除自訂名稱）',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '確定',
            onPress: (newName?: string) => {
              const trimmedName = (newName || '').trim();
              favoriteRoutesService.updateRoute(
                selectedRoute.fromStop,
                selectedRoute.toStop,
                { displayName: trimmedName === '' ? undefined : trimmedName }
              ).then(() => {
                loadFavoriteRoutes();
              });
            },
          },
        ],
        'plain-text',
        selectedRoute.displayName || ''
      );
    }
  };

  // 切換置頂狀態
  const handleTogglePin = async () => {
    setMenuVisible(false);
    if (!selectedRoute) return;

    await favoriteRoutesService.updateRoute(
      selectedRoute.fromStop,
      selectedRoute.toStop,
      { pinned: !selectedRoute.pinned }
    );
    loadFavoriteRoutes();
  };

  // 刪除路線
  const handleDelete = () => {
    setMenuVisible(false);
    if (!selectedRoute) return;

    const routeName = selectedRoute.displayName || `${selectedRoute.fromStop} → ${selectedRoute.toStop}`;

    if (Platform.OS === 'web') {
      if (confirm(`確定要刪除「${routeName}」嗎？`)) {
        favoriteRoutesService.removeRoute(
          selectedRoute.fromStop,
          selectedRoute.toStop
        ).then(() => {
          loadFavoriteRoutes();
        });
      }
    } else {
      Alert.alert(
        '刪除常用路線',
        `確定要刪除「${routeName}」嗎？`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '刪除',
            style: 'destructive',
            onPress: () => {
              favoriteRoutesService.removeRoute(
                selectedRoute.fromStop,
                selectedRoute.toStop
              ).then(() => {
                loadFavoriteRoutes();
              });
            },
          },
        ]
      );
    }
  };

  // 狀態徽章
  const renderBadge = (text: string) => {
    const t = (text || '').toString().trim();
    let style = styles.badgeGray;
    let textStyle: StyleProp<TextStyle> = styles.badgeText;
    const minuteMatch = t.match(/^(\d+)\s*分/);
    const minuteValue = minuteMatch ? parseInt(minuteMatch[1], 10) : null;

    if (t.includes('將到') || t.includes('進站') || t === '0') style = styles.badgeRed;
    else if (minuteValue !== null && minuteValue > 1 && minuteValue <= 3) {
      style = styles.badgeSoftRed;
      textStyle = styles.badgeSoftRedText;
    }
    else if (minuteValue !== null) style = styles.badgeBlue;
    else if (t.includes('未發') || t.includes('末班') || t.includes('未營運')) style = styles.badgeGray;
    
    return (
      <View style={[styles.badgeBase, style]}>
        <Text style={textStyle}>{t}</Text>
      </View>
    );
  };

  const renderFavoriteRouteItem = ({ item }: { item: UIArrival }) => (
    <TouchableOpacity
      onPress={() => openRouteDetails(item.routeName, item.rid, item.preferredDirection)}
    >
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.route}>{item.route}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>{renderBadge(item.estimatedTime)}</View>
      </View>
    </TouchableOpacity>
  );

  return (
    <WebRouteTransitionView backgroundColor="#152021" containerRef={pageTransitionRef}>
    <View style={styles.container}>
      {/* 側欄 */}
      <Animated.View
        style={[
          styles.sidebarContainer,
          {
            width: sidebarWidth,
            transform: [{ translateX: sidebarAnimation.interpolate({
              inputRange: [0, 1],
              outputRange: [-300, 0],
            })}],
          },
        ]}
      >
        <View style={styles.sidebarHeader}>
          <View>
            <Text style={styles.sidebarTitle}>Stop togo</Text>
            <Text style={styles.sidebarSubtitle}>選單</Text>
          </View>
          <TouchableOpacity
            onPress={() => setSidebarVisible(false)}
            style={styles.sidebarCloseButton}
          >
            <Text style={styles.sidebarCloseText}>×</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.sidebarContent}>
          {/* 首頁 */}
          <TouchableOpacity 
            style={styles.sidebarItem}
            onPress={() => {
              setSidebarVisible(false);
              setTimeout(() => router.push('/'), 300);
            }}
          >
            <Text style={styles.sidebarItemIcon}>🏠</Text>
            <Text style={styles.sidebarItemText}>首頁</Text>
          </TouchableOpacity>
          
          {/* 附近站牌 */}
          <TouchableOpacity 
            style={styles.sidebarItem}
            onPress={() => {
              setSidebarVisible(false);
              setTimeout(() => router.push('/search'), 300);
            }}
          >
            <Text style={styles.sidebarItemIcon}>📍</Text>
            <Text style={styles.sidebarItemText}>附近站牌</Text>
          </TouchableOpacity>
          
          {/* 路線規劃 */}
          <TouchableOpacity 
            style={styles.sidebarItem}
            onPress={() => {
              setSidebarVisible(false);
              setTimeout(() => router.push('/route'), 300);
            }}
          >
            <Text style={styles.sidebarItemIcon}>🚌</Text>
            <Text style={styles.sidebarItemText}>路線規劃</Text>
          </TouchableOpacity>
          
          {/* 乘車時間通知 */}
          <TouchableOpacity 
            style={styles.sidebarItem}
            onPress={() => {
              setSidebarVisible(false);
              setTimeout(() => {
                router.push({
                  pathname: '/bus-route' as any,
                  params: { routeName: '606' },
                });
              }, 300);
            }}
          >
            <Text style={styles.sidebarItemIcon}>606</Text>
            <Text style={styles.sidebarItemText}>606 路線詳情</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.sidebarItem}
            onPress={() => {
              setSidebarVisible(false);
              setTimeout(() => setNotificationModalVisible(true), 300);
            }}
          >
            <Text style={styles.sidebarItemIcon}>🔔</Text>
            <Text style={styles.sidebarItemText}>乘車時間通知</Text>
          </TouchableOpacity>
          
          {/* 地圖（僅手機顯示） */}
          {isMobileDevice && (
            <TouchableOpacity 
              style={styles.sidebarItem}
              onPress={() => {
                setSidebarVisible(false);
                setTimeout(() => router.push('/map'), 300);
              }}
            >
              <Text style={styles.sidebarItemIcon}>🗺️</Text>
              <Text style={styles.sidebarItemText}>地圖</Text>
            </TouchableOpacity>
          )}
          
          {/* 清除快取 */}
          <TouchableOpacity 
            style={styles.sidebarItem}
            onPress={async () => {
              if (Platform.OS === 'web') {
                if (confirm('確定要清除所有快取資料嗎？這將刪除常用路線、最近站牌等所有儲存的資料。')) {
                  await AsyncStorage.clear();
                  alert('快取已清除！頁面將重新載入。');
                  window.location.reload();
                }
              } else {
                Alert.alert(
                  '清除快取',
                  '確定要清除所有快取資料嗎？這將刪除常用路線、最近站牌等所有儲存的資料。',
                  [
                    { text: '取消', style: 'cancel' },
                    {
                      text: '確定',
                      style: 'destructive',
                      onPress: async () => {
                        await AsyncStorage.clear();
                        Alert.alert('完成', '快取已清除！請重新啟動應用程式。');
                      },
                    },
                  ]
                );
              }
            }}
          >
            <Text style={styles.sidebarItemIcon}>🗑️</Text>
            <Text style={styles.sidebarItemText}>清除快取</Text>
          </TouchableOpacity>
        </ScrollView>
      </Animated.View>

      {/* 主頁面內容 */}
      <Animated.View
        style={[
          styles.mainContent,
          { transform: [{ translateX: mainContentTranslate }] },
        ]}
      >
      {/* 搜尋框 */}
      <View style={styles.topBar}>
        <TouchableOpacity 
          style={styles.menuButton}
          onPress={() => setSidebarVisible(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.menuButtonText}>☰</Text>
        </TouchableOpacity>
        <View style={styles.searchBox}>
          <TouchableOpacity activeOpacity={0.8} onPress={() => router.push('/search')}>
            <View style={{ pointerEvents: 'none' }}>
              <TextInput
                placeholder="搜尋站牌"
                placeholderTextColor="#bdbdbd"
                style={styles.searchInput}
                editable={false}
                value=""
              />
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {favoriteRoutes.length > 0 ? (
        <View style={styles.quickRouteContainer}>
          <View style={styles.quickRouteTitleRow}>
            <Text style={styles.quickRouteTitle}>常用路線</Text>
          </View>
          <View style={styles.quickRouteRow}>
            <ScrollView
              ref={routeButtonScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.quickRouteScrollContent}
              style={styles.quickRouteScrollView}
            >
              {favoriteRoutes.slice(0, 5).map((route, index) => (
                <TouchableOpacity
                  key={route.id}
                  style={[
                    styles.quickRouteButton,
                    selectedRouteIndex === index && styles.quickRouteButtonActive,
                  ]}
                  onPress={() => {
                    selectedRouteIndexRef.current = index;
                    setSelectedRouteIndex(index);
                    scrollRouteButtonToCenter(index);
                    pagerRef.current?.setPage(index);
                    if (allFavoriteArrivals[index]) {
                      void prefetchFavoriteRouteDetails(allFavoriteArrivals[index]);
                    }
                  }}
                  onLongPress={() => handleLongPress(route)}
                  delayLongPress={Platform.OS === 'web' ? 300 : 500}
                  activeOpacity={0.7}
                >
                  {route.pinned ? <Text style={styles.pinIcon}>📌</Text> : null}
                  {route.displayName ? (
                    <Text style={[
                      styles.quickRouteDisplayName,
                      selectedRouteIndex === index && styles.quickRouteTextActive,
                    ]}>
                      {route.displayName}
                    </Text>
                  ) : (
                    <>
                      <Text style={[
                        styles.quickRouteFrom,
                        selectedRouteIndex === index && styles.quickRouteTextActive,
                      ]}>
                        {route.fromStop}
                      </Text>
                      <Text style={styles.quickRouteArrow}>→</Text>
                      <Text style={[
                        styles.quickRouteTo,
                        selectedRouteIndex === index && styles.quickRouteTextActive,
                      ]}>
                        {route.toStop}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.addRouteButtonInline}
              onPress={openRoutePlanner}
              activeOpacity={0.7}
            >
              <Text style={styles.addRouteButtonText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {!favoritesLoaded ? (
        <View style={styles.favoriteLoading}>
          <ActivityIndicator size="large" color="#6F73F8" />
        </View>
      ) : favoriteRoutes.length > 0 ? (
        <View style={styles.pagerContainer}>
          <PagerView
            ref={pagerRef}
            style={styles.pagerView}
            initialPage={0}
            onPageSelected={handlePageSelected}
          >
            {favoriteRoutes.map((route, index) => (
              <View key={route.id} style={styles.pageContainer}>
                <View style={styles.directionBar}>
                  <Text style={styles.directionBarText}>
                    {route.displayName || `${route.fromStop} → ${route.toStop}`}
                  </Text>
                </View>
                <FlatList
                  data={allFavoriteArrivals[index] || []}
                  renderItem={renderFavoriteRouteItem}
                  keyExtractor={item => item.key}
                  scrollEnabled
                  contentContainerStyle={styles.flatListContent}
                  extraData={allFavoriteArrivals[index]}
                  removeClippedSubviews
                />
              </View>
            ))}
          </PagerView>
        </View>
      ) : (
        <HomeEmptyState onAddRoute={openRoutePlanner} />
      )}
      </Animated.View>

      {/* 側欄遮罩 */}
      {sidebarVisible && (
        <TouchableOpacity
          style={styles.sidebarBackdrop}
          activeOpacity={1}
          onPress={() => setSidebarVisible(false)}
        />
      )}

      {/* PWA 安裝提示 */}
      <InstallPWA />
      
      {/* Service Worker 註冊 */}
      <ServiceWorkerRegister />

      {/* 通知設定 Modal */}
      <Modal
        visible={notificationModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setNotificationModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.notificationModalContainer}>
            <View style={styles.notificationModalHeader}>
              <Text style={styles.notificationModalTitle}>乘車時間通知</Text>
              <TouchableOpacity
                onPress={() => setNotificationModalVisible(false)}
                style={styles.notificationModalClose}
              >
                <Text style={styles.notificationModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>
            <NotificationSettings />
          </View>
        </View>
      </Modal>

      {/* 長按選單 Modal */}
      <Modal
        visible={menuVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <TouchableOpacity 
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}
        >
          <View style={styles.menuContainer}>
            <View style={styles.menuHeader}>
              <Text style={styles.menuTitle}>
                {selectedRoute?.displayName || `${selectedRoute?.fromStop} → ${selectedRoute?.toStop}`}
              </Text>
            </View>
            
            <TouchableOpacity
              style={styles.menuItem}
              onPress={handleRename}
            >
              <Text style={styles.menuItemIcon}>✏️</Text>
              <Text style={styles.menuItemText}>重新命名</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={handleTogglePin}
            >
              <Text style={styles.menuItemIcon}>
                {selectedRoute?.pinned ? '📌' : '📍'}
              </Text>
              <Text style={styles.menuItemText}>
                {selectedRoute?.pinned ? '取消置頂' : '置頂'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.menuItem, styles.menuItemDanger]}
              onPress={handleDelete}
            >
              <Text style={styles.menuItemIcon}>🗑️</Text>
              <Text style={[styles.menuItemText, styles.menuItemTextDanger]}>刪除</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuCancelButton}
              onPress={() => setMenuVisible(false)}
            >
              <Text style={styles.menuCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
    </WebRouteTransitionView>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#152021', 
    paddingTop: Platform.OS === 'ios' ? 50 : 28 
  },
  pagerContainer: {
    flex: 1,
  },
  favoriteLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagerView: {
    flex: 1,
  },
  pageContainer: {
    flex: 1,
    ...(Platform.OS === 'web' && {
      height: '100%',
    }),
  },
  flatListContent: {
    paddingBottom: 20,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 4,
  },
  menuButton: {
    width: 40,
    height: 46,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '400',
  },
  searchBox: { flex: 1 },
  searchInput: {
    height: 46,
    borderRadius: 50,
    backgroundColor: '#3a4243',
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
  },
  quickRouteContainer: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2b3435',
  },
  quickRouteTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 6,
  },
  quickRouteTitle: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
  },
  quickRouteRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  quickRouteScrollView: {
    flex: 1,
  },
  addRouteButtonInline: {
    width: 30,
    height: 30,
    borderRadius: 18,
    backgroundColor: '#6F73F8',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 20,
  },
  addRouteButtonText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '500',
    lineHeight: 28,
  },
  quickRouteScrollContent: {
    paddingHorizontal: 20,
    gap: 8,
  },
  quickRouteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2b3435',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    gap: 6,
  },
  quickRouteButtonActive: {
    backgroundColor: '#6F73F8',
  },
  quickRouteTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  pinIcon: {
    fontSize: 10,
    marginRight: -2,
  },
  quickRouteDisplayName: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  quickRouteFrom: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  quickRouteArrow: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  quickRouteTo: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  directionBar: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#2b3435',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  directionBarText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 25,
    paddingVertical: 18,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#263133',
  },
  route: { color: '#ffffff', fontSize: 20, fontWeight: '700' },
  directionText: { color: '#888', fontSize: 12, marginTop: 2 },
  badgeBase: {
    minWidth: 68,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  badgeRed: { backgroundColor: '#E74C3C' },
  badgeSoftRed: { backgroundColor: '#dccaca' },
  badgeSoftRedText: { color: '#D7343A', fontWeight: '800', fontSize: 16 },
  badgeBlue: { backgroundColor: '#6F73F8' },
  badgeGray: { backgroundColor: '#7f8686' },
  // 側欄樣式
  sidebarContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    backgroundColor: '#1f2627',
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 1000,
  },
  mainContent: {
    flex: 1,
    backgroundColor: '#141c1c',
  },
  sidebarBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    zIndex: 999,
  },
  sidebarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 50 : 28,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2b3435',
  },
  sidebarTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  sidebarSubtitle: {
    color: '#9aa6a6',
    fontSize: 14,
    marginTop: 2,
  },
  sidebarCloseButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sidebarCloseText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
  },
  sidebarContent: {
    flex: 1,
    padding: 20,
  },
  sidebarItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  sidebarItemIcon: {
    fontSize: 24,
    marginRight: 16,
  },
  sidebarItemText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
  sidebarPlaceholder: {
    color: '#9aa6a6',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 40,
  },
  // 長按選單樣式
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  notificationModalContainer: {
    backgroundColor: '#1f2627',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  notificationModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2b3435',
  },
  notificationModalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  notificationModalClose: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  notificationModalCloseText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
  },
  menuContainer: {
    backgroundColor: '#1f2627',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  menuHeader: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2b3435',
  },
  menuTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 12,
  },
  menuItemIcon: {
    fontSize: 20,
  },
  menuItemText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
  menuItemDanger: {
    borderTopWidth: 1,
    borderTopColor: '#2b3435',
  },
  menuItemTextDanger: {
    color: '#E74C3C',
  },
  menuCancelButton: {
    marginHorizontal: 20,
    marginTop: 8,
    paddingVertical: 14,
    backgroundColor: '#2b3435',
    borderRadius: 12,
    alignItems: 'center',
  },
  menuCancelText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
