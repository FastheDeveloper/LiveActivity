/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'DropTrackWidgets',
  // "." prefix appends to the app id → com.fasarticle.droptrack.widgets
  bundleIdentifier: '.widgets',
  // Must not exceed the app's own deployment target (SDK 57 floor: 16.4)
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  entitlements: {
    // Same App Group as the app — required later for sharing images/data
    // with the widget process (extensions have no network access).
    'com.apple.security.application-groups': ['group.com.fasarticle.droptrack'],
  },
};
