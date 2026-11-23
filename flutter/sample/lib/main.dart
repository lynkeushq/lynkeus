import 'dart:async';

import 'package:lynkeus_agent/lynkeus_agent.dart';
import 'package:material_ui/material_ui.dart';

final navigatorKey = GlobalKey<NavigatorState>();
final homeKey = GlobalKey<HomeState>();

void main() {
  LynkeusAgent.start(app: {'name': 'lynkeus_sample'});
  LynkeusAgent.register('reset', (_) {
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
    homeKey.currentState?.reset();
    return true;
  });
  runApp(const SampleApp());
}

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Lynkeus sample',
    navigatorKey: navigatorKey,
    debugShowCheckedModeBanner: false,
    theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo)),
    home: Home(key: homeKey),
  );
}

class Home extends StatefulWidget {
  const Home({super.key});

  @override
  State<Home> createState() => HomeState();
}

class HomeState extends State<Home> {
  final _name = TextEditingController();
  var _count = 0;
  String? _sentTo;
  var _secondsLeft = 0;
  Timer? _countdown;
  String? _picked;
  var _deleted = false;

  void reset() {
    _countdown?.cancel();
    _name.clear();
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _count = 0;
      _sentTo = null;
      _secondsLeft = 0;
      _picked = null;
      _deleted = false;
    });
  }

  void _send() {
    _countdown?.cancel();
    setState(() {
      _sentTo = _name.text;
      _secondsLeft = 3;
    });
    _countdown = Timer.periodic(const Duration(seconds: 1), (timer) {
      setState(() => _secondsLeft--);
      if (_secondsLeft == 0) timer.cancel();
    });
  }

  Future<void> _openList() async {
    final picked = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const Items()));
    if (picked != null) setState(() => _picked = picked);
  }

  Future<void> _confirmDelete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        key: const ValueKey('confirm-delete'),
        title: const Text('Delete everything?'),
        content: const Text('This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            key: const ValueKey('confirm'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) setState(() => _deleted = true);
  }

  @override
  void dispose() {
    _countdown?.cancel();
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Lynkeus sample')),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Count: $_count', key: const ValueKey('count'), style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 8),
        FilledButton(
          key: const ValueKey('increment'),
          onPressed: () => setState(() => _count++),
          child: const Text('Add one'),
        ),
        const SizedBox(height: 24),
        TextField(
          key: const ValueKey('name'),
          controller: _name,
          decoration: const InputDecoration(labelText: 'Name', hintText: 'Your name', border: OutlineInputBorder()),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 8),
        FilledButton(
          key: const ValueKey('send'),
          onPressed: _name.text.isEmpty ? null : _send,
          child: const Text('Send code'),
        ),
        if (_sentTo != null) ...[
          const SizedBox(height: 8),
          Text('Code sent to $_sentTo', key: const ValueKey('sent')),
          TextButton(
            key: const ValueKey('resend'),
            onPressed: _secondsLeft > 0 ? null : _send,
            child: Text(_secondsLeft > 0 ? 'Resend in $_secondsLeft' : 'Resend now'),
          ),
        ],
        const SizedBox(height: 24),
        OutlinedButton(key: const ValueKey('open-list'), onPressed: _openList, child: const Text('Open the list')),
        if (_picked != null) Text('Picked $_picked', key: const ValueKey('picked')),
        const SizedBox(height: 8),
        OutlinedButton(
          key: const ValueKey('delete'),
          onPressed: _confirmDelete,
          child: const Text('Delete everything'),
        ),
        if (_deleted) const Text('Everything was deleted', key: ValueKey('deleted')),
      ],
    ),
  );
}

class Items extends StatelessWidget {
  const Items({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Items')),
    body: ListView.builder(
      key: const ValueKey('items'),
      itemCount: 50,
      itemBuilder: (context, i) => ListTile(
        key: ValueKey('item-${i + 1}'),
        title: Text('Item ${i + 1}'),
        onTap: () => Navigator.pop(context, 'Item ${i + 1}'),
      ),
    ),
  );
}
