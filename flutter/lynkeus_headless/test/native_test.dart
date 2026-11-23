import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_headless/src/native.dart';

void main() {
  late Directory project;
  late Directory plugin;

  setUp(() {
    project = Directory.systemTemp.createTempSync('lynkeus-native-');
    plugin = Directory('${project.path}/pub-cache/isar_community_flutter_libs')..createSync(recursive: true);
    for (final file in [
      'macos/libisar.dylib',
      'macos/isar.xcframework/macos-arm64_x86_64/libisar.dylib',
      'macos/Classes/IsarFlutterLibsPlugin.swift',
      'linux/libisar.so',
      'linux/CMakeLists.txt',
    ]) {
      File('${plugin.path}/$file')
        ..createSync(recursive: true)
        ..writeAsStringSync('not a library');
    }
    final entry = {'name': 'isar_community_flutter_libs', 'path': '${plugin.path}/'};
    File('${project.path}/.flutter-plugins-dependencies').writeAsStringSync(
      jsonEncode({
        'plugins': {
          'macos': [entry],
          'linux': [entry],
          'ios': [entry],
        },
      }),
    );
  });

  tearDown(() => project.deleteSync(recursive: true));

  test('finds the libraries a plugin ships prebuilt for this machine, not those in its frameworks', () {
    expect(nativeLibraries(project, 'macos'), ['${plugin.path}/macos/libisar.dylib']);
    expect(nativeLibraries(project, 'linux'), ['${plugin.path}/linux/libisar.so']);
    expect(nativeLibraries(project, 'windows'), isEmpty);
  });

  test('nothing without the plugin list flutter pub get writes', () {
    File('${project.path}/.flutter-plugins-dependencies').deleteSync();
    expect(nativeLibraries(project, 'macos'), isEmpty);
  });

  test('a library that does not load is named with the reason, and the host goes on', () {
    final lines = loadNativeLibraries(project, 'macos');
    expect(lines, hasLength(1));
    expect(lines.single, startsWith('libisar.dylib not loaded ('));
  });
}
