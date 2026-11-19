import { AppRegistry } from 'react-native';
import { auto } from 'lynkeus-agent/auto';
import App from './src/App';
import { name as appName } from './app.json';

auto({ token: process.env.LYNKEUS_TOKEN });
AppRegistry.registerComponent(appName, () => App);
