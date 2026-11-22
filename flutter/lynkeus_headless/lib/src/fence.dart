import 'dart:io';

/// The real network, as far as `networkHosts` and no further: an automated harness pointed at production is the
/// accident this prevents. flutter_test answers every request with a 400 of its own; the host puts this in its place.
class FencedHttpOverrides extends HttpOverrides {
  FencedHttpOverrides(this.hosts);
  final Set<String> hosts;

  bool allows(String host) => hosts.contains(host) || hosts.contains(host.toLowerCase());

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    client.connectionFactory = (url, proxyHost, proxyPort) {
      final host = proxyHost ?? url.host;
      if (!allows(host)) {
        return Future.error(SocketException('lynkeus headless: $host is outside networkHosts (${hosts.join(', ')})'));
      }
      final port = proxyPort ?? url.port;
      if (proxyHost == null && (url.scheme == 'https' || url.scheme == 'wss')) {
        return SecureSocket.startConnect(host, port, context: context);
      }
      return Socket.startConnect(host, port);
    };
    return client;
  }
}
