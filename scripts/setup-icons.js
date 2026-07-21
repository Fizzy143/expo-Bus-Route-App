#!/usr/bin/env node

/**
 * 自動複製必要的圖示檔案到根目錄和 public/assets
 * 解決 Metro bundler 和 Web 版在開發時找不到圖示的問題
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'assets', 'images');
const PUBLIC_ASSETS_DIR = path.join(ROOT_DIR, 'public', 'assets');

// 確保 public/assets 目錄存在
if (!fs.existsSync(PUBLIC_ASSETS_DIR)) {
  fs.mkdirSync(PUBLIC_ASSETS_DIR, { recursive: true });
}

console.log('🔧 Setting up icons...\n');

// 複製到根目錄（Metro 需要）
const rootFiles = [
  { src: 'icon.png', dest: 'icon.png' },
  { src: 'splash-icon.png', dest: 'splash.png' }
];

rootFiles.forEach(({ src, dest }) => {
  const source = path.join(SOURCE_DIR, src);
  const destPath = path.join(ROOT_DIR, dest);

  try {
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, destPath);
      console.log(`✅ Copied ${dest} to root directory`);
    } else {
      console.warn(`⚠️  Source file not found: ${src}`);
    }
  } catch (error) {
    console.error(`❌ Failed to copy ${dest}:`, error.message);
  }
});

// 複製到 public/assets（Web 開發模式需要）
const publicAssets = [
  { src: 'icon.png', dest: 'icon.png' },
  { src: 'icon.png', dest: 'icon-192x192.png' },
  { src: 'icon.png', dest: 'icon-512x512.png' },
  { src: 'icon.png', dest: 'apple-touch-icon.png' },
  { src: 'favicon.png', dest: 'favicon.png' },
  { src: 'favicon.png', dest: 'favicon-32x32.png' },
  { src: 'android-icon-foreground.png', dest: 'android-icon.png' },
];

console.log('');
publicAssets.forEach(({ src, dest }) => {
  const source = path.join(SOURCE_DIR, src);
  const destPath = path.join(PUBLIC_ASSETS_DIR, dest);

  try {
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, destPath);
      console.log(`✅ Copied ${dest} to public/assets`);
    } else {
      console.warn(`⚠️  Source file not found: ${src}`);
    }
  } catch (error) {
    console.error(`❌ Failed to copy ${src}:`, error.message);
  }
});

console.log('\n✨ Icon setup complete!');
