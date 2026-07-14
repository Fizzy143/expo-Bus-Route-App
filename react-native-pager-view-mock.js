// Mock for react-native-pager-view on web platform
import React from 'react';
import { Dimensions, ScrollView, View } from 'react-native';

// Mock PagerView component for web
const PagerView = React.forwardRef(({ 
  children, 
  style, 
  initialPage = 0, 
  onPageSelected,
  ...props 
}, ref) => {
  const scrollViewRef = React.useRef(null);
  const [currentPage, setCurrentPage] = React.useState(initialPage);

  const scrollToPage = React.useCallback((page, animated) => {
    const screenWidth = Dimensions.get('window').width;
    scrollViewRef.current?.scrollTo({ x: page * screenWidth, animated });
  }, []);

  // Land on the requested initial page before the first paint so the pager
  // never visibly starts at page 0 and then slides to a non-zero initialPage.
  React.useLayoutEffect(() => {
    if (initialPage > 0) {
      scrollToPage(initialPage, false);
    }
    // Mount-only: later navigation goes through setPage / user scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose setPage/setPageWithoutAnimation like native PagerView
  React.useImperativeHandle(ref, () => ({
    setPage: (page) => scrollToPage(page, true),
    setPageWithoutAnimation: (page) => scrollToPage(page, false),
  }));

  const handleScroll = (event) => {
    const screenWidth = Dimensions.get('window').width;
    const contentOffsetX = event.nativeEvent.contentOffset.x;
    const newPage = Math.round(contentOffsetX / screenWidth);
    
    if (newPage !== currentPage && newPage >= 0) {
      setCurrentPage(newPage);
      if (onPageSelected) {
        onPageSelected({ nativeEvent: { position: newPage } });
      }
    }
  };

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      onScroll={handleScroll}
      onMomentumScrollEnd={handleScroll}
      scrollEventThrottle={16}
      decelerationRate="fast"
      snapToInterval={Dimensions.get('window').width}
      snapToAlignment="center"
      style={[style, { cursor: 'default' }]}
      contentContainerStyle={{ flexGrow: 1 }}
      {...props}
    >
      {React.Children.map(children, (child, index) => (
        <View 
          key={index} 
          style={{ 
            width: Dimensions.get('window').width,
            height: '100%',
          }}
        >
          {child}
        </View>
      ))}
    </ScrollView>
  );
});

PagerView.displayName = 'PagerView';

export default PagerView;
