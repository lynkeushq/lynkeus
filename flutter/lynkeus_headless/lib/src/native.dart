import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:flutter/foundation.dart';

/*
 * FFI plugins under flutter test.
 *
 * A plugin whose Dart side calls a native library through dart:ffi (isar_community, through
 * isar_community_flutter_libs) has no channel to stand in for: on a device the app bundles the library, and under
 * flutter test nothing loads it, so the first call fails (`Failed to lookup symbol 'isar_version'`). Many such plugins
 * also ship the library prebuilt for the desktop (`macos/libisar.dylib`, `linux/libisar.so`), which is the machine the
 * host runs on. The host loads those before the app starts: once a library is in the process, the plugin's own
 * `DynamicLibrary.open('libisar.dylib')` gets the loaded one (by install name on macOS, by soname on Linux), and
 * `DynamicLibrary.process()` finds its symbols. The app then runs on the real engine of its database, with its files
 * in the run's temporary folder, as on a phone.
 */

/// The prebuilt shared libraries the app's plugins ship for [os] (`macos`, `linux`): files directly in each plugin's
/// `<os>/` folder, as `.flutter-plugins-dependencies` (written by `flutter pub get`) lists the plugins. A library
/// inside a framework or an xcframework is the same one again, or a static archive, and is left alone.
@visibleForTesting
List<String> nativeLibraries(Directory project, String os) {
  final extension = switch (os) {
    'macos' => '.dylib',
    'linux' => '.so',
    _ => null,
  };
  if (extension == null) return const [];
  final Object? listed;
  try {
    listed = jsonDecode(File('${project.path}/.flutter-plugins-dependencies').readAsStringSync());
  } on Object {
    return const [];
  }
  final plugins = listed is Map ? listed['plugins'] : null;
  final forOs = plugins is Map ? plugins[os] : null;
  if (forOs is! List) return const [];
  final found = <String>[];
  for (final plugin in forOs) {
    final root = plugin is Map ? plugin['path'] : null;
    if (root is! String) continue;
    final folder = Directory('${root.endsWith('/') ? root : '$root/'}$os');
    if (!folder.existsSync()) continue;
    final files = folder.listSync(followLinks: false).whereType<File>().where((f) => f.path.endsWith(extension));
    found.addAll(files.map((f) => f.path).toList()..sort());
  }
  return found;
}

/// Loads [nativeLibraries] into the process. Returns a line per library for the host's log: its name, or why it did
/// not load (a plugin's desktop library may need the desktop embedder, which the host is not).
List<String> loadNativeLibraries(Directory project, [String os = '']) {
  final lines = <String>[];
  for (final path in nativeLibraries(project, os.isEmpty ? Platform.operatingSystem : os)) {
    final name = path.split('/').last;
    try {
      DynamicLibrary.open(path);
      lines.add(name);
    } on Object catch (error) {
      lines.add('$name not loaded (${'$error'.split('\n').first})');
    }
  }
  return lines;
}
