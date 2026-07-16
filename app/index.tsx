import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Modal,
  Platform,
  RefreshControl,
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
  const { name } = useLocalSearchParams<{ name?: string }>();
  const pageTransitionRef = useRef<HTMLElement | null>(null);
  const AUTO_REFRESH_MS = 10000;

  // 使用新版 Service
  const plannerRef = useRef(new BusPlannerService());
  const [serviceReady, setServiceReady] = useState(false);

  const [selectedStop, setSelectedStop] = useState<string>(name || '');
  const [arrivals, setArrivals] = useState<UIArrival[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  const intervalRef = useRef<any>(null);
  const favoriteIntervalRef = useRef<any>(null);
  const favoriteRefreshInFlightRef = useRef<boolean>(false);

  // 刷新冷卻時間（毫秒）
  const REFRESH_COOLDOWN = 3000; // 3 秒

  // 常用路線狀態
  const [favoriteRoutes, setFavoriteRoutes] = useState<FavoriteRoute[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(0);
  const selectedRouteIndexRef = useRef<number>(0);
  const favoriteRoutesRef = useRef<FavoriteRoute[]>([]);
  
  // 顯示模式: 'favorite' | 'nearby' | 'default'
  const [displayMode, setDisplayMode] = useState<'favorite' | 'nearby' | 'default'>('default');
  
  // 滑動相關 ref
  const pagerRef = useRef<PagerView>(null);
  const routeButtonScrollRef = useRef<ScrollView>(null);
  const [allFavoriteArrivals, setAllFavoriteArrivals] = useState<UIArrival[][]>([]);
  
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

  // 在應用啟動時請求位置權限
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          console.log('位置權限已授予');
        } else {
          console.log('位置權限被拒絕');
        }
      } catch (error) {
        console.error('請求位置權限時發生錯誤:', error);
      }
    })();
  }, []);

  // 初始化 Service 並加載最近站牌
  useEffect(() => {
    const initService = async () => {
      // 新版 BusPlannerService 不需要 initialize，constructor 已同步載入資料
      setServiceReady(true);

      // 如果 URL 參數有站牌名，優先使用
      if (name && typeof name === 'string') {
        setSelectedStop(name);
        await saveRecentStop(name);
        return;
      }

      // 嘗試加載最近使用的站牌
      try {
        const recentStop = await AsyncStorage.getItem('@recent_stop');
        if (recentStop) {
          console.log('使用最近站牌:', recentStop);
          setSelectedStop(recentStop);
          return;
        }
      } catch (error) {
        console.error('加載最近站牌失敗:', error);
      }

      // 嘗試使用地理位置找最近站牌
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
          console.log('定位權限已授予，正在定位...');
          const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          
          const nearestStop = plannerRef.current.findNearestStop(
            location.coords.latitude,
            location.coords.longitude
          );
          
          if (nearestStop) {
            console.log('找到最近站牌:', nearestStop);
            setSelectedStop(nearestStop);
            await saveRecentStop(nearestStop);
            return;
          }
        } else {
          console.log('定位權限未授予，使用默認站牌');
        }
      } catch (error) {
        console.error('無法取得地理位置:', error);
      }

      // 如果以上都失敗或沒有定位權限，使用默認站牌
      console.log('使用默認站牌: 捷運公館站');
      setSelectedStop('捷運公館站');
      await saveRecentStop('捷運公館站');
    };
    initService();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 僅掛載時初始化站牌（URL name→最近→定位→預設）；加入 name 會在參數變動時重置站牌/重新定位
  }, []);

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

  // 監聽 displayMode 和 favoriteRoutes 變化，確保切換到 favorite 模式時按鈕狀態同步
  const prevDisplayModeRef = useRef<'favorite' | 'nearby' | 'default'>(displayMode);
  useEffect(() => {
    // 只有當 displayMode 從非 favorite 切換到 favorite 時才同步按鈕高亮
    if (displayMode === 'favorite' && prevDisplayModeRef.current !== 'favorite' && 
        favoriteRoutes.length > 0) {
      // 只同步按鈕滾動位置，不改變 PagerView 的當前頁
      scrollRouteButtonToCenter(selectedRouteIndex);
    }
    prevDisplayModeRef.current = displayMode;
  }, [displayMode, favoriteRoutes.length, selectedRouteIndex]);

  useEffect(() => {
    selectedRouteIndexRef.current = selectedRouteIndex;
  }, [selectedRouteIndex]);

  useEffect(() => {
    favoriteRoutesRef.current = favoriteRoutes;
  }, [favoriteRoutes]);

  // 保存最近使用的站牌
  const saveRecentStop = async (stopName: string) => {
    try {
      await AsyncStorage.setItem('@recent_stop', stopName);
    } catch (error) {
      console.error('保存最近站牌失敗:', error);
    }
  };

  // 監聽站名或 Service 準備好後開始抓資料
  useEffect(() => {
    if (serviceReady && selectedStop) {
      fetchBusData(selectedStop, false); // 初始載入
      // 移除這裡的 loadFavoriteRoutes()，因為已經在 initService 中提前執行
      // 保存最近站牌
      saveRecentStop(selectedStop);
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => fetchBusData(selectedStop, true), AUTO_REFRESH_MS); // 自動更新傳 true
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (favoriteIntervalRef.current) clearInterval(favoriteIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interval 已顯式帶入當前 selectedStop（已列依賴）；加入 fetchBusData 會在每次 render / 手動刷新（refreshing 變動）時重設 10 秒計時器
  }, [selectedStop, serviceReady]);

  // 抓資料核心邏輯 (使用新 API)
  const fetchBusData = async (stopName = selectedStop, isAutoRefresh = false) => {
    try {
      if (!stopName || !serviceReady) return;
      setLoading(prev => prev && !refreshing);

      // 1. 取得該站名的所有代表性 SID
      const sids = plannerRef.current.getRepresentativeSids(stopName);
      
      if (sids.length === 0) {
        console.warn(`查無站牌 ID: ${stopName}`);
        setArrivals([]);
        setLastUpdate(new Date().toLocaleTimeString());
        return;
      }

      // 2. 平行抓取所有 SID 的公車資料（包含所有方向）
      console.log('Fetching data for SIDs:', sids);
      const allResults = await Promise.all(
        sids.map(sid => plannerRef.current.fetchBusesAtSid(sid))
      );
      
      // 3. 合併並轉換資料
      const allBuses = allResults.flat().flat();
      
      // 轉換為 UI 格式並排序 (使用共用比較器)
      const uiArrivals: UIArrival[] = allBuses
        .sort((a, b) => compareArrivals(a, b))
        .map((bus) => ({
          rid: bus.rid,
          route: bus.route,
          routeName: bus.route,
          preferredDirection: bus.direction || '',
          estimatedTime: bus.timeText,
          key: `${bus.rid}-${bus.route}-${bus.direction || 'default'}`, // 使用 rid+route+direction 區分
        }));

      setArrivals(uiArrivals);
      setLastUpdate(new Date().toLocaleTimeString());

    } catch (e) {
      console.error('fetchBusData error', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    const now = Date.now();
    const timeSinceLastRefresh = now - lastRefreshTime;
    
    // 如果距離上次刷新少於冷卻時間，則忽略
    if (timeSinceLastRefresh < REFRESH_COOLDOWN) {
      console.log(`請稍候 ${Math.ceil((REFRESH_COOLDOWN - timeSinceLastRefresh) / 1000)} 秒後再刷新`);
      return;
    }
    
    setLastRefreshTime(now);
    setRefreshing(true);
    fetchBusData(selectedStop, false); // 手動刷新重新載入所有資料
  };

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
    if (favoriteIntervalRef.current) clearInterval(favoriteIntervalRef.current);

    favoriteIntervalRef.current = setInterval(async () => {
      try {
        console.log('🔄 自動刷新常用路線動態...');
        const currentRoutes = await favoriteRoutesService.getAllRoutes(true);
        syncFavoriteRoutes(currentRoutes);

        if (currentRoutes.length > 0) {
          clampSelectedRouteIndex(currentRoutes.length);
          loadAllFavoriteRoutesArrivals(currentRoutes, true);
        } else {
          setDisplayMode('default');
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
      console.log('已載入常用路線:', routes.length, '條');

      if (routes.length > 0) {
        const selectedIndex = clampSelectedRouteIndex(routes.length);
        seedFavoriteArrivalsFromCache(routes, selectedIndex);
        syncFavoriteRoutes(routes);
        setDisplayMode('favorite');
        loadAllFavoriteRoutesArrivals(routes, false);
        startFavoriteAutoRefresh();
      } else {
        syncFavoriteRoutes([]);
        setDisplayMode('default');
        setAllFavoriteArrivals([]);
        if (favoriteIntervalRef.current) clearInterval(favoriteIntervalRef.current);
      }
    } catch (error) {
      console.error('載入常用路線失敗:', error);
    }
  };

  // 預載所有常用路線的公車動態（自動更新時保留舊資料直到新資料完成）
  const loadAllFavoriteRoutesArrivals = async (routes: FavoriteRoute[], isAutoRefresh = false) => {
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

  const renderItem = ({ item }: { item: UIArrival }) => (
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

      {/* 常用路線快捷按鈕或路線規劃 */}
      <View style={styles.quickRouteContainer}>
        <View style={styles.quickRouteTitleRow}>
          <Text style={styles.quickRouteTitle}>
            {favoriteRoutes.length > 0 ? '常用路線' : '路線規劃'}
          </Text>
        </View>
        <View style={styles.quickRouteRow}>
          {favoriteRoutes.length > 0 ? (
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
                    selectedRouteIndex === index && displayMode === 'favorite' && styles.quickRouteButtonActive
                  ]}
                  onPress={() => {
                    selectedRouteIndexRef.current = index;
                    setSelectedRouteIndex(index);
                    scrollRouteButtonToCenter(index);
                    // 觸發 PagerView 滑動到對應頁面
                    if (pagerRef.current) {
                      pagerRef.current.setPage(index);
                    }
                    if (allFavoriteArrivals[index]) {
                      void prefetchFavoriteRouteDetails(allFavoriteArrivals[index]);
                    }
                  }}
                  onLongPress={() => handleLongPress(route)}
                  delayLongPress={Platform.OS === 'web' ? 300 : 500}
                  activeOpacity={0.7}
                >
                  {route.pinned && <Text style={styles.pinIcon}>📌</Text>}
                  {route.displayName ? (
                    <Text style={[
                      styles.quickRouteDisplayName,
                      selectedRouteIndex === index && displayMode === 'favorite' && styles.quickRouteTextActive
                    ]}>{route.displayName}</Text>
                  ) : (
                    <>
                      <Text style={[
                        styles.quickRouteFrom,
                        selectedRouteIndex === index && displayMode === 'favorite' && styles.quickRouteTextActive
                      ]}>{route.fromStop}</Text>
                      <Text style={styles.quickRouteArrow}>→</Text>
                      <Text style={[
                        styles.quickRouteTo,
                        selectedRouteIndex === index && displayMode === 'favorite' && styles.quickRouteTextActive
                      ]}>{route.toStop}</Text>
                    </>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <View style={styles.quickRouteScrollView} />
          )}
          <TouchableOpacity 
            style={styles.addRouteButtonInline}
            onPress={openRoutePlanner}
            activeOpacity={0.7}
          >
            <Text style={styles.addRouteButtonText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 通知設定 */}
      {/* 移到 FlatList 的 ListHeaderComponent */}

      {/* 根據優先順序顯示公車動態 */}
      {displayMode === 'favorite' && favoriteRoutes.length > 0 ? (
        // 顯示常用路線公車（可左右滑動切換）
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
                  keyExtractor={(item) => item.key}
                  scrollEnabled={true}
                  contentContainerStyle={styles.flatListContent}
                  extraData={allFavoriteArrivals[index]}
                  removeClippedSubviews={true}
                />
              </View>
            ))}
          </PagerView>
        </View>
      ) : (
        // 顯示預設站牌公車
        <>
          <View style={styles.directionBar}>
            <Text style={styles.directionBarText}>{selectedStop}</Text>
            {Platform.OS === 'web' && (
              <TouchableOpacity
                onPress={onRefresh}
                disabled={refreshing}
                style={styles.refreshButton}
              >
                <Text style={styles.refreshButtonText}>
                  {refreshing ? '更新中...' : '刷新'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator size="large" />
              <Text style={{ color: '#999', marginTop: 8 }}>載入中...</Text>
            </View>
          ) : (
            <FlatList
              data={arrivals}
              renderItem={renderItem}
              keyExtractor={(item) => item.key}
              ListHeaderComponent={<NotificationSettings />}
              refreshControl={
                Platform.OS !== 'web' ? (
                  <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
                ) : undefined
              }
              extraData={arrivals}
              removeClippedSubviews={true}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>目前無公車資訊</Text>
                  <Text style={styles.hintText}>或查無此站牌資料</Text>
                </View>
              }
              contentContainerStyle={{ paddingBottom: 120 }}
            />
          )}
        </>
      )}

      {/* 更新時間 */}
      <View style={styles.footer}>
        <Text style={styles.updateText}>更新時間：{lastUpdate || '—'}</Text>
      </View>
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
  refreshButton: {
    backgroundColor: '#6F73F8',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  refreshButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
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
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { marginTop: 40, alignItems: 'center' },
  emptyText: { color: '#9aa6a6', fontSize: 18, fontWeight: '700' },
  hintText: { color: '#6d746f', marginTop: 18 },
  footer: { position: 'absolute', bottom: 18, left: 0, right: 0, alignItems: 'center' },
  updateText: { color: '#6f7a78', fontSize: 12 },
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
