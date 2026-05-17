import { usePathname } from 'expo-router';
import React, { PropsWithChildren, useEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';

import {
  clearWebRouteTransition,
  consumeWebRouteTransition,
  getWebRouteSnapshot,
} from './web-route-transition';

type Props = PropsWithChildren<{
  backgroundColor: string;
  containerRef?: React.RefObject<HTMLElement | null>;
}>;

export default function WebRouteTransitionView({
  backgroundColor,
  children,
  containerRef,
}: Props) {
  const pathname = usePathname();
  const translateX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const transition = consumeWebRouteTransition(pathname);
    const snapshot = getWebRouteSnapshot();

    if (!transition || prefersReducedMotion) {
      translateX.setValue(0);
      snapshot?.remove();
      return;
    }

    const screenWidth = window.innerWidth;
    const isBackTransition = transition.direction === 'back';
    const startX = isBackTransition ? 0 : screenWidth;
    const snapshotExitX = isBackTransition ? screenWidth + 72 : -48;

    translateX.setValue(startX);

    if (snapshot) {
      snapshot.style.zIndex = isBackTransition ? '10000' : '9998';
    }

    const enterAnimation = Animated.timing(translateX, {
      toValue: 0,
      duration: isBackTransition ? 1 : 280,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    });

    const snapshotAnimation = snapshot?.animate(
      [
        { transform: 'translateX(0px)', opacity: 1 },
        { transform: `translateX(${snapshotExitX}px)`, opacity: 1 },
      ],
      {
        duration: isBackTransition ? 320 : 280,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      }
    );

    enterAnimation.start(() => {
      snapshotAnimation?.cancel();
      snapshot?.remove();
    });

    return () => {
      enterAnimation.stop();
      snapshotAnimation?.cancel();
      snapshot?.remove();
    };
  }, [pathname, translateX]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    const currentContainer = containerRef?.current ?? null;

    return () => {
      if (!currentContainer) {
        clearWebRouteTransition();
      }
    };
  }, [containerRef]);

  return (
    <Animated.View
      ref={containerRef as any}
      style={{
        flex: 1,
        backgroundColor,
        overflow: 'hidden',
        zIndex: 9999,
        transform: [{ translateX }],
      }}
    >
      {children}
    </Animated.View>
  );
}
