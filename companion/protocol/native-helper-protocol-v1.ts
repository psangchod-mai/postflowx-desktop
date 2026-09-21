export type NativeTimecodeSource = 'embedded' | 'derived' | 'synthetic' | 'unknown';
export type NativeSeekMode = 'exact' | 'fast';
export type NativeThumbFormat = 'jpg' | 'png';
export type NativeThumbMode = 'fast' | 'exact';

export interface NativeHelperRequest<T = Record<string, unknown>> {
  id: string;
  cmd: string;
  payload: T;
}

export interface NativeHelperError {
  code: string;
  message: string;
}

export interface NativeHelperResponse<T = Record<string, unknown>> {
  id: string;
  ok: boolean;
  result?: T;
  error?: NativeHelperError;
}

export interface NativeHelperEvent<T = Record<string, unknown>> {
  event: string;
  data: T;
}

export interface NativeAssetIdentity {
  assetId: string;
  path: string;
  displayName: string;
}

export interface NativeTimecodeInfo {
  source: NativeTimecodeSource;
  startTimecode: string;
  fps: number;
  timecodeBase: number;
  dropFrame: boolean;
  durationFrames: number;
  durationTimecode: string;
  hasTimecodeTrack: boolean;
}

export interface NativePlayheadState {
  assetId: string;
  status: 'playing' | 'paused' | 'stopped';
  seconds: number;
  frameIndex: number;
  timecode: string;
}

export interface NativeThumbnailResult {
  timecode: string;
  frameIndex: number;
  path: string;
  width?: number;
  height?: number;
  cacheHit?: boolean;
}

export interface NativeThumbnailStripResult {
  items: NativeThumbnailResult[];
}
