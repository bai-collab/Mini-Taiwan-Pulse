import { describe, expect, it } from "vitest";
import {
  buildChiayiWeekWindow,
  latestTrafficSlot,
  rollingTaiwanDates,
  taiwanDateKey,
  trafficSlotAtTimestamp,
  trafficSlotTimestamp,
  type ChiayiTrafficData,
  weekCursorMax,
  weekCursorTimestamp,
} from "./liveTopics";

describe("嘉義市延伸主題時間契約", () => {
  it("交通槽位以台北時區的五分鐘間隔轉成 Unix 秒", () => {
    const dayStart = Date.parse("2026-09-10T00:00:00+08:00") / 1000;
    expect(trafficSlotTimestamp("2026-09-10", 0)).toBe(dayStart);
    expect(trafficSlotTimestamp("2026-09-10", 2)).toBe(dayStart + 600);
  });

  it("將交通槽位限制在當日 288 格，避免滑桿越界", () => {
    const dayStart = Date.parse("2026-09-10T00:00:00+08:00") / 1000;
    expect(trafficSlotTimestamp("2026-09-10", -4)).toBe(dayStart);
    expect(trafficSlotTimestamp("2026-09-10", 400)).toBe(dayStart + 287 * 300);
    expect(trafficSlotTimestamp("2026-09-10", 12.9)).toBe(dayStart + 12 * 300);
  });

  it("只把 API 回應的最後已填槽位交給交通回放控制器", () => {
    const traffic = {
      congestion: { lastPopulatedSlot: 286 },
    } as ChiayiTrafficData;
    expect(latestTrafficSlot(traffic)).toBe(286);
    expect(latestTrafficSlot({ congestion: null } as ChiayiTrafficData)).toBe(0);
    expect(latestTrafficSlot(null)).toBe(0);
  });

  it("台灣日期鍵使用 Asia/Taipei，而不是瀏覽器所在時區", () => {
    expect(taiwanDateKey(new Date("2026-09-09T16:30:00.000Z"))).toBe("2026-09-10");
  });

  it("建立以抓取當下為結束點的七日台灣時間窗", () => {
    const now = new Date("2026-09-10T04:40:00.000Z");
    expect(rollingTaiwanDates("2026-09-10")).toEqual([
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
    ]);
    const window = buildChiayiWeekWindow("2026-09-10", now);
    expect(window.windowStartAt).toBe("2026-09-03T16:00:00.000Z");
    expect(window.windowEndAt).toBe("2026-09-10T04:40:00.000Z");
    expect(weekCursorMax(window, 3600)).toBe(156);
    expect(weekCursorTimestamp(window.windowStartAt, 156, 3600)).toBe(
      Date.parse("2026-09-10T04:00:00.000Z") / 1000,
    );
  });

  it("把任意回放時間限制在交通當日五分鐘槽位", () => {
    const timestamp = trafficSlotTimestamp("2026-09-10", 23) + 120;
    expect(trafficSlotAtTimestamp(timestamp)).toBe(23);
  });
});
