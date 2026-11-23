import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

// flutter_test draws every family it was not given as Ahem boxes. Material's text on iOS asks for the system's San
// Francisco families, which only exist on Apple's platforms: Roboto stands in for them, so a screenshot reads.
const _systemFamilies = [
  'Roboto',
  'CupertinoSystemText',
  'CupertinoSystemDisplay',
  '.SF Pro Text',
  '.SF Pro Display',
  '.SF UI Text',
  '.SF UI Display',
  '.AppleSystemUIFont',
];

/// The names a manifest family is loaded under. A package's font (`packages/cupertino_icons/CupertinoIcons`) is asked
/// for by that whole name, which `TextStyle(package:)` and `IconData(fontPackage:)` make; its bare name is kept too.
@visibleForTesting
List<String> familyNames(String family) => family.startsWith('packages/') ? [family, family.split('/').last] : [family];

/// Loads the app's own fonts (its FontManifest), Roboto under the system family names, and MaterialIcons. Returns
/// the families loaded. Runs outside fake time: the engine answers font loads on the real event loop.
Future<List<String>> loadFonts(String? fontsDir) async {
  final loaded = <String>[];
  try {
    final manifest = jsonDecode(await rootBundle.loadString('FontManifest.json')) as List<Object?>;
    for (final entry in manifest.whereType<Map<String, Object?>>()) {
      final family = entry['family'] as String?;
      final fonts = (entry['fonts'] as List<Object?>? ?? const []).whereType<Map<String, Object?>>();
      if (family == null) continue;
      for (final name in familyNames(family)) {
        final loader = FontLoader(name);
        for (final font in fonts) {
          loader.addFont(rootBundle.load(font['asset']! as String));
        }
        await loader.load();
      }
      loaded.add(family);
    }
  } on FlutterError {
    // An app without fonts of its own has no manifest.
  }
  final dir = fontsDir == null ? null : Directory(fontsDir);
  if (dir == null || !dir.existsSync()) return loaded;
  ByteData? read(String name) {
    final file = File('${dir.path}/$name');
    return file.existsSync() ? ByteData.sublistView(Uint8List.fromList(file.readAsBytesSync())) : null;
  }

  final faces = [
    for (final name in ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Bold.ttf']) ?read(name),
  ];
  if (faces.isNotEmpty) {
    for (final family in _systemFamilies) {
      final loader = FontLoader(family);
      for (final face in faces) {
        loader.addFont(Future.value(face));
      }
      await loader.load();
      loaded.add(family);
    }
  }
  final icons = read('MaterialIcons-Regular.otf');
  if (icons != null && !loaded.contains('MaterialIcons')) {
    await (FontLoader('MaterialIcons')..addFont(Future.value(icons))).load();
    loaded.add('MaterialIcons');
  }
  return loaded;
}
