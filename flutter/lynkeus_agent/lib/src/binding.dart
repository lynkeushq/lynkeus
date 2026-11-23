import 'package:flutter/widgets.dart';

import 'capture.dart';
import 'fastsim.dart';

/// The agent's binding: a WidgetsFlutterBinding whose captured frames are the same on every run and host, and which
/// on Lynkeus FastSim gives the app the device's safe area and answers its plugins. `LynkeusAgent.start()` makes it
/// when the app has not made a binding yet. An app with a binding class of its own extends this one instead of
/// WidgetsFlutterBinding and makes it before calling `LynkeusAgent.start()`.
class LynkeusBinding extends WidgetsFlutterBinding with FrameCapture, FastSimHooks {}
