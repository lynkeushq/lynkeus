import 'package:flutter/widgets.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';
import 'package:lynkeus_plugins/lynkeus_plugins.dart';

void main() {
  LynkeusAgent.start();
  LynkeusPlugins.ensureInitialized();
  runApp(const Directionality(textDirection: TextDirection.ltr, child: Text('Hello from Lynkeus')));
}
