/**
 * Library Event Sync - coalesces real-time library add/remove events into
 * targeted syncs.
 *
 * Plex SSE and the Jellyfin/Emby plugin SSE can report individual item
 * add/remove events. Rather than syncing on every single event (a large
 * import can fire hundreds in seconds), events are collected per server for
 * a debounce window and a single targeted sync is enqueued once the window
 * closes. Removals with a resolvable item id are additionally tombstoned
 * immediately, ahead of that sync, so reads stop showing them right away.
 *
 * Failure stance: this is a latency optimization only. If events never
 * arrive, are malformed, or any step here throws, the scheduled sync cadence
 * and the incremental count-mismatch escalation in librarySync.ts still cover
 * everything - nothing here is load-bearing for correctness.
 */

import { librarySyncService } from './librarySync.js';
import { enqueueLibrarySyncFromEvent } from '../jobs/librarySyncQueue.js';

export interface LibraryChangeEvent {
  serverId: string;
  serverName: string;
  type: 'added' | 'removed';
  itemId: string | null;
}

// Collect events for this long after the first one before enqueuing a sync.
// Does not reset on later events in the same window, so a long-running import
// still gets synced periodically instead of being pushed back indefinitely.
const DEBOUNCE_WINDOW_MS = 30_000;

const pendingWindows = new Map<string, NodeJS.Timeout>();

export function recordLibraryEvent(event: LibraryChangeEvent): void {
  if (event.type === 'removed' && event.itemId) {
    void librarySyncService
      .tombstoneItemsByRatingKey(event.serverId, [event.itemId])
      .catch((err: unknown) => {
        console.warn(
          `[LibraryEvents] Failed to tombstone item ${event.itemId} for ${event.serverName}:`,
          err
        );
      });
  }

  // Plex's timeline fires its "added" terminal state (5) for ANY item that
  // finishes metadata processing - refreshes, analysis, and the entire
  // nightly maintenance window included, not just new media (verified
  // against a live server: refreshing an existing movie ends in state 5).
  // An item Tracearr already tracks is a refresh, not an add, and must not
  // open a sync window - otherwise Plex maintenance makes the dashboard
  // show a library sync every 30 seconds for hours. Unknown items and probe
  // failures fall through to the sync (fail-open: a missed skip costs one
  // redundant incremental sync, a missed add would delay ingestion by up to
  // the 12h scheduled cadence).
  if (event.type === 'added' && event.itemId) {
    if (pendingWindows.has(event.serverId)) {
      return; // a window is already open; ride along without probing
    }
    const itemId = event.itemId;
    void librarySyncService
      .hasActiveItemByRatingKey(event.serverId, itemId)
      .then((known) => {
        if (!known) openSyncWindow(event);
      })
      .catch(() => {
        openSyncWindow(event);
      });
    return;
  }

  openSyncWindow(event);
}

function openSyncWindow(event: LibraryChangeEvent): void {
  if (process.env.DISABLE_LIBRARY_SYNC === 'true') {
    return; // event-triggered syncs disabled; playback/session tracking is unaffected
  }

  if (pendingWindows.has(event.serverId)) {
    return; // a window is already open for this server; this event rides along
  }

  const timer = setTimeout(() => {
    pendingWindows.delete(event.serverId);
    void enqueueLibrarySyncFromEvent(event.serverId).catch((err: unknown) => {
      console.warn(
        `[LibraryEvents] Failed to enqueue event-triggered sync for ${event.serverName}:`,
        err
      );
    });
  }, DEBOUNCE_WINDOW_MS);

  pendingWindows.set(event.serverId, timer);
}

/**
 * Clear all pending debounce windows without enqueuing their syncs. Used on
 * shutdown so a closing process doesn't leave dangling timers.
 */
export function clearPendingLibraryEventSync(serverId: string): void {
  const timer = pendingWindows.get(serverId);
  if (timer) {
    clearTimeout(timer);
    pendingWindows.delete(serverId);
  }
}

export function clearPendingLibraryEventSyncs(): void {
  for (const timer of pendingWindows.values()) {
    clearTimeout(timer);
  }
  pendingWindows.clear();
}
