import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/services.dart';

import 'standins.dart';

/*
 * Stand-ins for what a phone knows of where it is and what runs beside the app: its position (geolocator), the
 * names of places (geocoding), work the OS runs later (workmanager), home-screen widgets (home_widget), the display's
 * modes (flutter_displaymode) and a restart (restart_app). Each keeps what the app told it, and a driver command
 * reads or sets it.
 */

/// The position a phone reports with nothing set: where the iOS Simulator and the Android emulator put themselves.
const _devicePositions = {
  'ios': (latitude: 37.33233141, longitude: -122.0312186),
  'android': (latitude: 37.4219983, longitude: -122.084),
};

/// What the system geocoder answers near those two positions; a case adds its own with the location command.
const _knownPlaces = <Map<String, Object?>>[
  {
    'latitude': 37.33233141,
    'longitude': -122.0312186,
    'name': 'Apple Park',
    'street': 'Apple Park Way',
    'locality': 'Cupertino',
    'subAdministrativeArea': 'Santa Clara County',
    'administrativeArea': 'CA',
    'postalCode': '95014',
    'country': 'United States',
    'isoCountryCode': 'US',
  },
  {
    'latitude': 37.4219983,
    'longitude': -122.084,
    'name': 'Googleplex',
    'street': '1600 Amphitheatre Pkwy',
    'locality': 'Mountain View',
    'subAdministrativeArea': 'Santa Clara County',
    'administrativeArea': 'CA',
    'postalCode': '94043',
    'country': 'United States',
    'isoCountryCode': 'US',
  },
];

/// geolocator's permission statuses, by the number its channel answers.
const _permissions = ['denied', 'deniedForever', 'whileInUse', 'always'];

/// What the device plugins hold for a run.
class DeviceState {
  DeviceState(String platform) {
    final at = _devicePositions[platform] ?? _devicePositions['ios']!;
    latitude = at.latitude;
    longitude = at.longitude;
  }

  late double latitude;
  late double longitude;
  var accuracy = 5.0;

  /// What checking the location permission answers, and what the next request ends in (the person's choice); with no
  /// choice set, a request answers the permission as it is.
  var permission = 'whileInUse';
  String? request;

  /// Whether location services are on, system-wide.
  var service = true;
  final places = [..._knownPlaces];
  final widgetData = <String, Object?>{};
  final widgetUpdates = <Map<String, Object?>>[];
  final tasks = <String, Map<String, Object?>>{};
  var restarts = 0;
  final _positionListeners = <void Function()>[];

  Map<String, Object?> position() => {
    'latitude': latitude,
    'longitude': longitude,
    'accuracy': accuracy,
    'altitude': 0.0,
    'altitude_accuracy': 0.0,
    'heading': 0.0,
    'heading_accuracy': 0.0,
    'speed': 0.0,
    'speed_accuracy': 0.0,
    'timestamp': DateTime.now().millisecondsSinceEpoch,
    'is_mocked': false,
  };

  /// The known place nearest to a position, within 25 km; none further away, as a geocoder finds nothing at sea.
  Map<String, Object?>? placeNear(double lat, double lon) {
    Map<String, Object?>? best;
    var nearest = 25.0;
    for (final place in places) {
      final km = _km(lat, lon, (place['latitude']! as num).toDouble(), (place['longitude']! as num).toDouble());
      if (km <= nearest) {
        best = place;
        nearest = km;
      }
    }
    return best;
  }

  static double _km(double lat1, double lon1, double lat2, double lon2) {
    double rad(double d) => d * math.pi / 180;
    final a =
        math.pow(math.sin(rad(lat2 - lat1) / 2), 2) +
        math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.pow(math.sin(rad(lon2 - lon1) / 2), 2);
    return 6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
  }
}

Map<Object?, Object?> _args(List<Object?> args) => args.isNotEmpty && args.first is Map ? args.first! as Map : const {};

/// Puts the device stand-ins on [standIns] and their commands on [register].
void installDevicePlugins(
  StandIns standIns,
  DeviceState state,
  List<String> launched,
  void Function(String name, FutureOr<Object?> Function(Object? params) handler) register,
  Future<void> Function(String channel, ByteData? message) fromPlatform,
) {
  const codec = StandardMethodCodec();
  int permissionNumber(String name) => _permissions.indexOf(name).clamp(0, _permissions.length - 1);
  bool allowed() => state.permission == 'whileInUse' || state.permission == 'always';

  // geolocator: a fixed position, the permission and service states a case sets, and the position stream.
  const positions = 'flutter.baseflow.com/geolocator_updates';
  const services = 'flutter.baseflow.com/geolocator_service_updates';
  void emitPosition() => unawaited(fromPlatform(positions, codec.encodeSuccessEnvelope(state.position())));
  void emitService() => unawaited(fromPlatform(services, codec.encodeSuccessEnvelope(state.service ? 1 : 0)));
  PlatformException? unavailable() {
    if (!state.service) {
      return PlatformException(code: 'LOCATION_SERVICES_DISABLED', message: 'Location services are off');
    }
    if (!allowed()) {
      return PlatformException(
        code: 'PERMISSION_DENIED',
        message: 'User denied permissions to access the device\'s location.',
      );
    }
    return null;
  }

  standIns.add('flutter.baseflow.com/geolocator', (method, args) {
    switch (method) {
      case 'checkPermission':
        return permissionNumber(state.permission);
      case 'requestPermission':
        final choice = state.request;
        if (choice != null) {
          state
            ..permission = choice
            ..request = null;
        }
        return permissionNumber(state.permission);
      case 'isLocationServiceEnabled':
        return state.service;
      case 'getCurrentPosition' || 'getLastKnownPosition':
        final failure = unavailable();
        if (failure != null) throw failure;
        return state.position();
      case 'getLocationAccuracy' || 'requestTemporaryFullAccuracy':
        return 0;
      case 'openAppSettings':
        launched.add('app-settings:');
        return true;
      case 'openLocationSettings':
        launched.add('app-settings:location');
        return true;
    }
    return null;
  });
  standIns.add(positions, (method, args) {
    if (method == 'listen') {
      final failure = unavailable();
      if (failure != null) throw failure;
      state._positionListeners.add(emitPosition);
      scheduleMicrotask(emitPosition);
    } else if (method == 'cancel') {
      state._positionListeners.clear();
    }
    return null;
  });
  standIns.add(services, (method, args) {
    if (method == 'listen') scheduleMicrotask(emitService);
    return null;
  });

  // geocoding up to 4.x speaks this channel; 5.x has no channel to fall back to (its iOS and Android classes are
  // Pigeon proxies), so under a host it fails as a geocoder with no answer does, and an app's fallback takes over.
  standIns.add('flutter.baseflow.com/geocoding', (method, args) {
    final a = _args(args);
    switch (method) {
      case 'placemarkFromCoordinates':
        final place = state.placeNear((a['latitude']! as num).toDouble(), (a['longitude']! as num).toDouble());
        if (place == null) throw PlatformException(code: 'NOT_FOUND', message: 'No address found');
        return [
          {
            for (final e in place.entries)
              if (e.key != 'latitude' && e.key != 'longitude') e.key: e.value,
          },
        ];
      case 'locationFromAddress':
        final wanted = '${a['address'] ?? ''}'.toLowerCase();
        final found = state.places.where(
          (p) => [p['name'], p['locality'], p['street']].any((v) => v is String && v.toLowerCase().contains(wanted)),
        );
        if (wanted.isEmpty || found.isEmpty) throw PlatformException(code: 'NOT_FOUND', message: 'No location found');
        return [
          for (final p in found)
            {
              'latitude': p['latitude'],
              'longitude': p['longitude'],
              'timestamp': DateTime.now().millisecondsSinceEpoch,
            },
        ];
      case 'isPresent':
        return true;
    }
    return null;
  });

  // home_widget: what the app saves for its widgets, and each update it asks for, kept for the widgets command.
  standIns.add('home_widget', (method, args) {
    final a = _args(args);
    switch (method) {
      case 'saveWidgetData':
        final id = '${a['id']}';
        if (a['data'] == null) {
          state.widgetData.remove(id);
        } else {
          state.widgetData[id] = a['data'];
        }
        return true;
      case 'getWidgetData':
        return state.widgetData[a['id']] ?? a['defaultValue'];
      case 'updateWidget':
        state.widgetUpdates.add({
          for (final e in a.entries)
            if (e.value != null) '${e.key}': e.value,
        });
        return true;
      case 'isRequestPinWidgetSupported' || 'canScheduleExactWidgetUpdates':
        return false;
      case 'getInstalledWidgets':
        return const <Object?>[];
    }
    return null;
  });

  // workmanager (0.10, Pigeon): the tasks the app registers stay scheduled, and none of them runs.
  standIns.add('dev.flutter.pigeon.workmanager_platform_interface.WorkmanagerHostApi', (method, args) {
    final request = args.isNotEmpty ? args.first : null;
    switch (method) {
      case 'registerOneOffTask' || 'registerPeriodicTask' || 'registerProcessingTask':
        // A Pigeon request object arrives as the list of its fields: the unique name, then the task's name.
        final fields = request is List ? request : const [];
        final name = fields.isNotEmpty ? '${fields[0]}' : '';
        state.tasks[name] = {
          'uniqueName': name,
          'taskName': fields.length > 1 ? '${fields[1]}' : null,
          'kind': method.replaceFirst('register', '').replaceFirst('Task', '').toLowerCase(),
        };
        return null;
      case 'cancelByUniqueName':
        state.tasks.remove('$request');
        return null;
      case 'cancelByTag' || 'cancelAll':
        if (method == 'cancelAll') state.tasks.clear();
        return null;
      case 'isScheduledByUniqueName':
        return state.tasks.containsKey('$request');
      case 'printScheduledTasks':
        return state.tasks.keys.join('\n');
    }
    return null;
  });

  // flutter_displaymode: one 120 Hz mode, which it stays in.
  const mode = {'id': 0, 'width': 1080, 'height': 2424, 'refreshRate': 120.0};
  standIns.add('flutter_display_mode', (method, args) {
    return switch (method) {
      'getSupportedModes' => [mode],
      'getActiveMode' || 'getPreferredMode' => mode,
      _ => null,
    };
  });

  // restart_app: a host cannot start the app over; the restart is counted and reported done.
  standIns.add('restart', (method, args) {
    switch (method) {
      case 'restartCapability':
        return {'fullProcessRestart': false, 'flutterEngineRestart': false, 'platformDefaultMode': 'platformDefault'};
      case 'restartApp':
        state.restarts++;
        return {'success': true, 'mode': 'platformDefault'};
    }
    return null;
  });

  register('location', (params) {
    final p = params is Map ? params : const {};
    if (p['latitude'] is num) state.latitude = (p['latitude']! as num).toDouble();
    if (p['longitude'] is num) state.longitude = (p['longitude']! as num).toDouble();
    if (p['accuracy'] is num) state.accuracy = (p['accuracy']! as num).toDouble();
    for (final key in ['permission', 'request']) {
      final value = p[key];
      if (value == null) continue;
      if (!_permissions.contains(value)) {
        throw ArgumentError('$key is one of ${_permissions.join(', ')}, not $value');
      }
      if (key == 'permission') state.permission = '$value';
      if (key == 'request') state.request = '$value';
    }
    if (p['service'] is bool) {
      state.service = p['service']! as bool;
      emitService();
    }
    if (p['place'] is Map) state.places.insert(0, (p['place']! as Map).cast<String, Object?>());
    if (p.containsKey('latitude') || p.containsKey('longitude')) {
      for (final listener in List.of(state._positionListeners)) {
        listener();
      }
    }
    return {
      'latitude': state.latitude,
      'longitude': state.longitude,
      'permission': state.permission,
      'request': ?state.request,
      'service': state.service,
    };
  });
  register('widgets', (params) {
    final out = {'data': Map.of(state.widgetData), 'updates': List.of(state.widgetUpdates)};
    if (params is Map && params['clear'] == true) state.widgetUpdates.clear();
    return out;
  });
  register('tasks', (params) => {'scheduled': state.tasks.values.toList(), 'restarts': state.restarts});
}
