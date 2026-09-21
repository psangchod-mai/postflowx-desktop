export function nowIso(): string {
  return new Date().toISOString();
}

export function ticksToSeconds(ticks: string, ticksPerSecond = 254016000000): number {
  return Number(BigInt(ticks) * 1000n / BigInt(ticksPerSecond)) / 1000;
}

export function secondsToTicks(seconds: number, ticksPerSecond = 254016000000): string {
  return (BigInt(Math.round(seconds * ticksPerSecond))).toString();
}
