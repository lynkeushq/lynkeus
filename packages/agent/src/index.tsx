export { Lynkeus } from './Lynkeus';
export type { LynkeusProps } from './Lynkeus';
export { qa, host } from './registry';
export type { ClientOptions, Socket } from './client';
export type { Backend, Snapshot } from './backend';

type Client = typeof import('./client');
type Handling = typeof import('./handlers');

// Required when called, not when this file is imported: an app that imports <Lynkeus> from here and
// leaves it disabled, as a release build does, never evaluates the client or what reads the screen.
export const start: Client['start'] = (options) => (require('./client') as Client).start(options);
export const createHandlers: Handling['createHandlers'] = (navigation, backend) => (require('./handlers') as Handling).createHandlers(navigation, backend);
export const dispatch: Handling['dispatch'] = (handlers, method, params, navigation) =>
  (require('./handlers') as Handling).dispatch(handlers, method, params, navigation);
export { reactNavigationAdapter, noNavigation } from './navigation';
export type { NavigationAdapter, RouteInfo } from './navigation';
export { PROTOCOL_VERSION } from './protocol';
export { record as traceRecord } from './trace';
export type {
  AgentEvent,
  AuthEvent,
  CoreMethods,
  Element,
  ElementKind,
  Frame,
  HelloEvent,
  HiddenReason,
  NavigationEvent,
  PressOptions,
  Request,
  RequestRecord,
  Response,
  Screen,
  SwipeParams,
  Target,
  WaitForParams,
} from './protocol';
