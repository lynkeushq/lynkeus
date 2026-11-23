import fs from 'node:fs';
import path from 'node:path';

/** What `lynkeus_plugins` makes work on a host, by the plugin's platform interface in the app's `pubspec.lock`. */
export type PluginNeed = { package: string; because: string; failure: string };

/** The versions the lock resolved, by package name. Reads only what the lock's `packages:` section says. */
export const lockedVersions = (lock: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const block of lock.split(/^ {2}(?=[A-Za-z_][\w]*:\s*$)/m).slice(1)) {
    const name = /^([A-Za-z_]\w*):/.exec(block)?.[1];
    const version = /^\s+version:\s*"?([^"\s]+)"?/m.exec(block)?.[1];
    if (name && version) out.set(name, version);
  }
  return out;
};

const atLeast = (version: string, floor: string): boolean => {
  const a = version.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  return true;
};

/**
 * The plugins in the app's lock that have no method-channel default and so fail on a host without `lynkeus_plugins`:
 * sqflite 2.4+ (its platform interface is in the lock) and shared_preferences' async API (interface 2.4.0 or later,
 * which exists whether or not the app uses it: the companion does nothing off a host).
 */
export const pluginsNeeded = (root: string): PluginNeed[] => {
  let lock: string;
  try {
    lock = fs.readFileSync(path.join(root, 'pubspec.lock'), 'utf8');
  } catch {
    return [];
  }
  const locked = lockedVersions(lock);
  const needs: PluginNeed[] = [];
  const sqflite = locked.get('sqflite_platform_interface');
  if (sqflite)
    needs.push({
      package: `sqflite_platform_interface ${sqflite}`,
      because: 'sqflite 2.4 or later is in pubspec.lock (often through cached_network_image)',
      failure: 'a database fails on a host with "databaseFactory not initialized", and cached network images show their error widget',
    });
  const prefs = locked.get('shared_preferences_platform_interface');
  if (prefs && atLeast(prefs, '2.4.0'))
    needs.push({
      package: `shared_preferences_platform_interface ${prefs}`,
      because: 'shared_preferences has its async API (SharedPreferencesAsync, SharedPreferencesWithCache)',
      failure: 'it fails on a host with "The SharedPreferencesAsyncPlatform instance must be set"',
    });
  return needs;
};

/** Plugins whose screen is a native view: blank on any host, with nothing to fix. A hint, not a check. */
const NATIVE_VIEWS = ['webview_flutter', 'google_maps_flutter', 'adaptive_platform_ui', 'video_player'];

export const nativeViewPlugins = (root: string): string[] => {
  try {
    const locked = lockedVersions(fs.readFileSync(path.join(root, 'pubspec.lock'), 'utf8'));
    return NATIVE_VIEWS.filter((name) => locked.has(name));
  } catch {
    return [];
  }
};
