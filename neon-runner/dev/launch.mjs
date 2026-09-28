// Shared dev helper (owned by orchestrator). Launch headless Chromium for play-testing.
// Usage: import { launch } from './launch.mjs'; const browser = await launch();
import { chromium } from '../node_modules/playwright/index.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const CANDIDATES = [
  `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
];

export async function launch(opts = {}) {
  const executablePath = process.env.CHROME_PATH || CANDIDATES.find(existsSync);
  return chromium.launch({
    executablePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
    ...opts,
  });
}
