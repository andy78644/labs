# Neon Runner — 實驗 brief

## 目的
複製 [Turbo Kart Rally](https://github.com/bridge-mind/turbo-kart-rally) 的做法：主 agent 先寫架構約定，再由多個 sub-agent 平行開發各自負責的檔案，最後整合並試玩。先用一款規則簡單的遊戲驗證這個流程。

## 遊戲：Neon Runner（3D 無盡跑酷）
- 霓虹／synthwave 風格。角色自動往前跑，速度隨時間增加
- 操作：←/→ 或 A/D 換道（3 條跑道），↑/W/Space 跳，↓/S 滑鏟；手機可用滑動手勢
- 障礙：低矮柵欄（要跳）、高空橫桿（要滑）、整條擋住的牆（要換道）
- 收集：金幣；道具有磁鐵、護盾、2 倍分數
- 撞到障礙就結束 → 結算畫面（分數、金幣、最高紀錄存 localStorage）→ 重來
- 標題畫面背景跑 demo

## 技術限制
- Three.js r170，用 import map 從 jsDelivr 載入。純 ES modules，**不要 build step**
- **零素材檔**：模型、貼圖、音效、音樂全部在載入時用程式碼生成（Web Audio 合成）
- 用 `python3 -m http.server` 就能跑
- 桌機 60fps，手機要能玩

## 架構約定（sub-agent 開始前，主 agent 先寫好）
- `ARCHITECTURE.md`：模組職責、介面、座標系統（跑道寬、lane x 座標、世界往 -z 前進或世界往 +z 移動擇一並寫清楚）、時間步長
- `src/config.js`：所有數值調整參數（速度曲線、跳躍高度、障礙生成機率、道具時長、顏色主題）
- `src/events.js`：event bus（`on/off/emit`），並列出所有事件名稱和 payload，例如 `coin:collected`、`player:hit`、`powerup:start/end`、`game:start/over/pause`、`speed:changed`

## Sub-agent 分工（每個只能改自己的檔案）

| Agent | 負責檔案 | 交付內容 |
|---|---|---|
| 1 · World | `src/world.js`, `src/textures.js` | 無限延伸的跑道 chunk 回收機制、霓虹網格地面、天空和遠景山脈、燈光、bloom 後製 |
| 2 · Player | `src/player.js`, `src/input.js` | 角色模型與跑步、跳、滑的動畫；換道補間；碰撞盒；鍵盤和觸控輸入 |
| 3 · Hazards & FX | `src/spawner.js`, `src/effects.js` | 障礙、金幣、道具的生成規則（保證一定有路可走）；物件池；粒子特效、撞擊鏡頭震動 |
| 4 · Game & UI | `index.html`, `src/main.js`, `src/game.js`, `src/hud.js`, `src/audio.js`, `styles.css` | 主迴圈、狀態機、分數、HUD、標題和結算畫面、合成音效和 BGM，最後負責整合 |

## 流程
1. 主 agent 寫 `ARCHITECTURE.md`、`config.js`、`events.js`，再加上各模組只有 export 簽名的 stub
2. 同時啟動 4 個 sub-agent，每個都用 stub 在真的瀏覽器裡測自己那一塊
3. Agent 4（或主 agent）整合並實際試玩：截圖確認畫面、確認沒有 console error、能從頭玩到結束再重來
4. 修掉整合時出現的 bug，並寫 `README.md`（玩法、如何執行、這個 agent 流程的紀錄）
5. `git init` 並 commit

## 驗收
- [ ] 本機 server 開起來就能玩，沒有 console error
- [ ] 三種障礙都有，都要用對應動作才能過
- [ ] 金幣、3 種道具可以用
- [ ] 有音效和 BGM
- [ ] 死亡 → 結算 → 重來的流程正常，最高紀錄會保存
- [ ] 至少 3 張實際遊玩截圖放在 `docs/screenshots/`
