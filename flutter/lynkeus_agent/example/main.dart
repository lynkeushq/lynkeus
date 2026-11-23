import 'package:flutter/widgets.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';

// Run with: flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
void main() {
  LynkeusAgent.start();
  runApp(
    WidgetsApp(
      color: const Color(0xFF1B5E20),
      navigatorObservers: [LynkeusAgent.navigatorObserver],
      pageRouteBuilder: <T>(settings, builder) =>
          PageRouteBuilder<T>(settings: settings, pageBuilder: (context, _, _) => builder(context)),
      home: const Center(child: Text('Hello from Lynkeus', key: Key('greeting'))),
    ),
  );
}
