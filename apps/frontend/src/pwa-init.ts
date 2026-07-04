import { getDataProxy } from '@frontend/worker/worker.proxy';

/**
 * Reload-storm circuit breaker.
 *
 * A service-worker update that takes control mid-session triggers
 * `window.location.reload()` inside vite-plugin-pwa's register runtime
 * (prompt mode, on the `controlling` event). Under pathological conditions —
 * DevTools "Update on reload" force-installing a new SW version on every
 * load, or an old auto-skipWaiting-era SW handing off against the current
 * prompt-mode runtime — that reload re-arms the same listener and the page
 * reloads forever, several times a second, fetching only /sw.js (+ its map)
 * because everything else is precached. Seen live on staging 2026-07-04.
 *
 * The breaker counts page loads in sessionStorage (per-tab, survives
 * reloads, dies with the tab). Four loads inside 15 seconds is a storm no
 * human causes by hand: we unregister every service worker, skip SW
 * registration for this page load, and let the next load start clean.
 * Cost of a false trip: one re-precache. Cost of no breaker: a hung tab.
 */
const SW_STORM_KEY = 'sw-reload-guard';
const SW_STORM_WINDOW_MS = 15_000;
const SW_STORM_LIMIT = 4;

let swStormLockout: boolean | null = null;

export function swReloadStormDetected(): boolean {
  if (swStormLockout !== null) return swStormLockout;
  try {
    const now = Date.now();
    const loads = (JSON.parse(sessionStorage.getItem(SW_STORM_KEY) ?? '[]') as number[]).filter(
      (t) => now - t < SW_STORM_WINDOW_MS,
    );
    loads.push(now);
    sessionStorage.setItem(SW_STORM_KEY, JSON.stringify(loads));
    swStormLockout = loads.length >= SW_STORM_LIMIT;
    if (swStormLockout) {
      console.error(
        `[PWA] Reload storm detected (${loads.length} loads in ${SW_STORM_WINDOW_MS / 1000}s) — unregistering service workers and skipping SW registration for this load.`,
      );
      sessionStorage.removeItem(SW_STORM_KEY);
      if ('serviceWorker' in navigator) {
        void navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((r) => r.unregister())))
          .catch(() => {});
      }
    }
  } catch {
    swStormLockout = false; // sessionStorage unavailable (rare) — never block boot
  }
  return swStormLockout;
}

/**
 * True when the app is running as an installed PWA rather than a regular
 * browser tab. iOS Safari uses navigator.standalone (non-standard, still
 * required); every other browser reports via display-mode media query.
 */
function isInstalledPWA(): boolean {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(standalone || iosStandalone);
}

export async function requestStoragePersistence() {
  if (!navigator.storage || !navigator.storage.persist) {
    return;
  }

  const isPersisted = await navigator.storage.persisted();
  if (isPersisted) {
    return;
  }

  // Always try once at start — a browser tab MIGHT grant it based on engagement
  // signals (Chrome/Edge). If denied here (common on iOS Safari and cold Chrome
  // sessions), register a one-shot retry for when the user installs the PWA —
  // browsers grant persist more readily to installed apps.
  const result = await navigator.storage.persist();
  if (result) {
    console.info('[Storage] Persistence granted.');
    return;
  }

  // Browser policy call, not an error — log at debug so it doesn't look
  // like a bug in DevTools.
  console.debug('[Storage] Persistence denied by browser policy; will retry on install.');

  if (!isInstalledPWA()) {
    window.addEventListener(
      'appinstalled',
      () => {
        void requestStoragePersistence();
      },
      { once: true },
    );
  }
}

export function initPWA() {
  // Trip the breaker (and record this load) before anything SW-related runs.
  swReloadStormDetected();

  // Request persistence as early as possible
  requestStoragePersistence();

  // NOTE: the service worker is registered in exactly ONE place —
  // `useRegisterSW()` inside PwaUpdatePrompt (mounted once at RootLayout,
  // present on every route including auth pages). This module used to ALSO
  // call `registerSW()`, which created a second workbox-window instance;
  // each instance classifies updates it didn't initiate as "external" and
  // arms its own reload-on-controlling listener, multiplying reloads during
  // the 2026-07-04 staging reload storm. Do not add a second registration.

  // Listen for messages from the SW.
  //   - `SW_PRECACHE_PROGRESS`: precache progress signal (dev only).
  //   - `sync-now`: silent-sync push landed. The SW can't reach the
  //     DataWorker directly (workers can't share Comlink handles across
  //     SW ↔ page boundaries), so it fans out to open clients and each
  //     open client kicks its own sync. Idempotent — processQueue
  //     dedupes concurrent calls.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SW_PRECACHE_PROGRESS') {
        const { progress, asset } = event.data.payload;
        if (asset) {
          console.info(`[PWA] Syncing ${asset}...`, 60 + (progress * 0.3));
        }
        return;
      }
      if (event.data?.type === 'sync-now') {
        void (async () => {
          try {
            const proxy = await getDataProxy();
            await proxy.sync.processQueue();
          } catch (err) {
            console.warn('[PWA] sync-now: processQueue failed', err);
          }
        })();
      }
    });
  }
}