import 'dart:io';
import 'dart:ui';

import 'package:flutter/foundation.dart';

/// What `lynkeus headless start` hands the host in the environment: the driver, the launch facts and the screen.
class HostSettings {
  HostSettings({
    required this.token,
    required this.port,
    required this.driverHost,
    required this.platform,
    required this.size,
    required this.devicePixelRatio,
    required this.networkHosts,
    this.locale,
    this.epoch,
    this.seed,
    this.fontsDir,
  });

  factory HostSettings.fromEnvironment([Map<String, String>? environment]) {
    final env = environment ?? Platform.environment;
    final window = RegExp(
      r'^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:@(\d+(?:\.\d+)?))?$',
    ).firstMatch(env['LYNKEUS_WINDOW'] ?? '');
    final tag = env['LYNKEUS_LOCALE'];
    final parts = tag?.split(RegExp('[-_]'));
    final epoch = env['LYNKEUS_EPOCH'];
    return HostSettings(
      token: env['LYNKEUS_TOKEN'] ?? '',
      port: int.tryParse(env['LYNKEUS_PORT'] ?? '') ?? 8123,
      driverHost: env['LYNKEUS_HOST']?.isNotEmpty ?? false ? env['LYNKEUS_HOST']! : '127.0.0.1',
      platform: env['LYNKEUS_PLATFORM'] == 'android' ? TargetPlatform.android : TargetPlatform.iOS,
      size: window == null ? const Size(402, 874) : Size(double.parse(window[1]!), double.parse(window[2]!)),
      devicePixelRatio: window?[3] == null ? 3 : double.parse(window![3]!),
      networkHosts: (env['LYNKEUS_NETWORK_HOSTS'] ?? '127.0.0.1,localhost,::1,10.0.2.2')
          .split(',')
          .map((h) => h.trim())
          .where((h) => h.isNotEmpty)
          .toSet(),
      locale: parts == null || parts.first.isEmpty
          ? null
          : Locale.fromSubtags(languageCode: parts.first, countryCode: parts.length > 1 ? parts.last : null),
      epoch: epoch == null
          ? null
          : (int.tryParse(epoch) != null
                ? DateTime.fromMillisecondsSinceEpoch(int.parse(epoch))
                : DateTime.tryParse(epoch)),
      seed: env['LYNKEUS_SEED'],
      fontsDir: env['LYNKEUS_FONTS'],
    );
  }

  final String token;
  final int port;
  final String driverHost;
  final TargetPlatform platform;

  /// In logical points.
  final Size size;
  final double devicePixelRatio;
  final Set<String> networkHosts;
  final Locale? locale;

  /// The instant the app's clock starts at.
  final DateTime? epoch;
  final String? seed;

  /// Where Roboto and MaterialIcons are (the Flutter SDK's material_fonts).
  final String? fontsDir;

  String get platformName => platform == TargetPlatform.android ? 'android' : 'ios';
}
