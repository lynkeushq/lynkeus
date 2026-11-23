import 'dart:io';

/// Where a host lets the app's requests go when the project names nothing else: this machine, and the emulator's
/// name for it.
const defaultNetworkHosts = {'127.0.0.1', 'localhost', '::1', '10.0.2.2'};

/// The hosts `LYNKEUS_NETWORK_HOSTS` names (comma-separated; the CLI sets it from `flutterHost.networkHosts`), or the
/// defaults.
Set<String> networkHostsFrom(Map<String, String> env) {
  final named = env['LYNKEUS_NETWORK_HOSTS'];
  if (named == null) return defaultNetworkHosts;
  return named.split(',').map((h) => h.trim()).where((h) => h.isNotEmpty).toSet();
}

/// Airplane mode on a host (`lynkeus os network off`): every request the app makes fails as a phone's would, a replayed
/// one included, until it is on again. A request `netmock` answers still gets its answer.
abstract final class HostNetwork {
  static var online = true;

  static SocketException get offline => const SocketException(
    'lynkeus: the network is off (lynkeus os network off): the request fails as with no signal',
  );
}

/// The real network, as far as `networkHosts` and no further: an automated harness pointed at production, or a run
/// that depends on the internet, is the accident this prevents. A request `netmock` answers never gets here.
class FencedHttpOverrides extends HttpOverrides {
  FencedHttpOverrides(this.hosts);
  final Set<String> hosts;

  bool allows(String host) => hosts.contains(host) || hosts.contains(host.toLowerCase());

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    client.connectionFactory = (url, proxyHost, proxyPort) {
      final host = proxyHost ?? url.host;
      if (!HostNetwork.online) return Future.error(HostNetwork.offline);
      if (!allows(host)) return Future.error(SocketException(blockedMessage(host, hosts)));
      final port = proxyPort ?? url.port;
      if (proxyHost == null && (url.scheme == 'https' || url.scheme == 'wss')) {
        return SecureSocket.startConnect(host, port, context: context);
      }
      return Socket.startConnect(host, port);
    };
    return client;
  }
}

/// Why a request did not leave the host, and the two ways to let the case through.
String blockedMessage(String host, Set<String> hosts) =>
    'lynkeus: $host is outside networkHosts (${hosts.join(', ')}): mock the request (app.mock in the case, or '
    'lynkeus mock), or allow the host with "flutterHost": { "networkHosts": [...] } in lynkeus.config.json';
