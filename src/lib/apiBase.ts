import { Capacitor } from '@capacitor/core';

/**
 * Universal API Base URL resolution for Native Apps (Capacitor Android & iOS) and Cloud Deployments.
 *
 * In native mobile builds (Android & iOS WebView), relative fetch('/api/...') calls resolve
 * to the production backend server (https://www.smartrun.in), while preserving standard local
 * relative paths during local development and cloud web deployments.
 */
export const PRODUCTION_APP_ORIGIN = 'https://www.smartrun.in';
export const CAPACITOR_APK_HOSTNAME = 'app.smartrun.in';

export interface ApiBaseResolutionContext {
  explicitApiUrl?: string;
  isNativePlatform?: boolean;
  platform?: string;
  origin?: string;
  hostname?: string;
  port?: string;
}

function isLocalhostLikeUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2' || host === '::1';
  } catch {
    return /localhost|127\.0\.0\.1|10\.0\.2\.2/i.test(urlStr);
  }
}

/**
 * Pure, testable API Base URL resolver across Native Android/iOS APK and Web.
 * Guarantees APK builds (running at https://app.smartrun.in) ALWAYS call https://www.smartrun.in
 * and never route API traffic to localhost or a bundled asset host.
 */
export function resolveApiBaseUrl(ctx: ApiBaseResolutionContext): string {
  const origin = String(ctx.origin || '').trim();
  const hostname = String(ctx.hostname || '').trim().toLowerCase();
  const port = String(ctx.port || '').trim();
  const platform = String(ctx.platform || '').trim().toLowerCase();

  const isCapacitorNative =
    Boolean(ctx.isNativePlatform) ||
    platform === 'android' ||
    platform === 'ios' ||
    hostname === CAPACITOR_APK_HOSTNAME ||
    origin.startsWith('capacitor://') ||
    origin.startsWith('ionic://') ||
    origin.startsWith('file://') ||
    (origin === 'https://localhost' && (!port || port === '443')) ||
    hostname === '10.0.2.2';

  const explicit = String(ctx.explicitApiUrl || '').trim().replace(/\/+$/, '');
  if (explicit && (explicit.startsWith('http://') || explicit.startsWith('https://'))) {
    // Never allow a stray localhost/127.0.0.1 env value to hijack production APK or smartrun.in web traffic
    const isProductionWeb = hostname === 'smartrun.in' || hostname === 'www.smartrun.in';
    if ((isCapacitorNative || isProductionWeb) && isLocalhostLikeUrl(explicit)) {
      return isCapacitorNative ? PRODUCTION_APP_ORIGIN : '';
    }
    return explicit;
  }

  if (isCapacitorNative) {
    return PRODUCTION_APP_ORIGIN;
  }

  return '';
}

export const API_BASE_URL: string = (() => {
  const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : ((process as any)?.env || {});
  const explicitApiUrl = env.VITE_API_URL || env.VITE_API_BASE_URL || '';

  if (typeof window === 'undefined') {
    return resolveApiBaseUrl({ explicitApiUrl });
  }

  const nativeWindowCap =
    typeof (window as any).Capacitor !== 'undefined' &&
    Boolean((window as any).Capacitor?.isNativePlatform?.());

  return resolveApiBaseUrl({
    explicitApiUrl,
    isNativePlatform: Capacitor.isNativePlatform() || nativeWindowCap,
    platform: Capacitor.getPlatform(),
    origin: window.location.origin || '',
    hostname: window.location.hostname || '',
    port: window.location.port || '',
  });
})();

/**
 * Helper to safely construct full API URLs across Web and Capacitor platforms.
 */
export function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (!API_BASE_URL) return cleanPath;
  return `${API_BASE_URL.replace(/\/+$/, '')}${cleanPath}`;
}
