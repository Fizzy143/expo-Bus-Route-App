import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface HomeEmptyStateProps {
  onAddRoute(): void;
}

export default function HomeEmptyState({ onAddRoute }: HomeEmptyStateProps) {
  return (
    <View testID="home-empty-state" style={styles.container}>
      <Text style={styles.title}>尚未新增常用路線</Text>
      <Text style={styles.description}>
        新增經常搭乘的路線，即可在首頁快速查看公車動態。
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="新增常用路線"
        activeOpacity={0.75}
        onPress={onAddRoute}
        style={styles.button}
      >
        <Text style={styles.buttonText}>新增常用路線</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 72,
  },
  title: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  description: {
    color: '#9aa6a6',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    maxWidth: 320,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#6F73F8',
    borderRadius: 22,
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});
