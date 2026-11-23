import 'package:flutter/widgets.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';
import 'package:lynkeus_headless/lynkeus_headless.dart';

// `npx lynkeus headless start` writes a file like this one under .lynkeus/host/ and runs it with `flutter test`;
// it calls the app's own main(), so the same cases run with no simulator.
Future<void> appMain() async {
  LynkeusAgent.start();
  runApp(const Directionality(textDirection: TextDirection.ltr, child: Text('Hello from Lynkeus')));
}

void main() {
  hostApp(appMain, name: 'example');
}
