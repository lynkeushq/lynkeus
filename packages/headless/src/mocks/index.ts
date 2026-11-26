export { installDefaultMocks, type InstallOptions } from './install.js';
export { registeredApp } from './registered.js';
// Opt-in: an app that uses one of these passes it in `overrides`; the case commands that drive them (`biometrics`,
// `scan`, `gallery`) need it.
export {
  biometrics,
  fastImage,
  imagePicker,
  inAppReview,
  reanimated,
  vectorIconsNative,
  video,
  visionCamera,
  type DeviceVersion,
  type LocaleDefault,
  type MockFactory,
} from './factories.js';
