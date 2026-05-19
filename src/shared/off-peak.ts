// DeepSeek off-peak pricing window. As of late 2025, DeepSeek charges
// 50% less for chat completions between UTC 16:30 and UTC 00:30 (an
// 8-hour window crossing midnight). Documented at
// https://api-docs.deepseek.com/quick_start/pricing. If you switch
// providers or DeepSeek changes the window, edit the constants below
// — this isn't config because it's tied to a specific vendor.

const OFF_PEAK_START_MIN = 16 * 60 + 30; // 16:30 UTC = 990
const OFF_PEAK_END_MIN = 30;             // 00:30 UTC = 30

export function isWithinDeepSeekOffPeak(now: Date = new Date()): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Window crosses midnight: t >= 16:30 OR t < 00:30.
  return minutes >= OFF_PEAK_START_MIN || minutes < OFF_PEAK_END_MIN;
}

export function describeOffPeakWindow(): string {
  return "UTC 16:30 – 00:30 (DeepSeek off-peak)";
}

export function minutesUntilOffPeakStart(now: Date = new Date()): number {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (isWithinDeepSeekOffPeak(now)) return 0;
  return OFF_PEAK_START_MIN - minutes;
}
