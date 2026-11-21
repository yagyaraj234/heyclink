const appId = "com.yagyaraj.kitchen";

module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_AUTH_MODE !== "firebase") return config;

  const origin = new URL(process.env.EXPO_PUBLIC_INVITE_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== process.env.EXPO_PUBLIC_INVITE_ORIGIN) {
    throw new Error("EXPO_PUBLIC_INVITE_ORIGIN must be an HTTPS origin.");
  }
  return {
    ...config,
    extra: { ...config.extra, householdAuth: true, inviteOrigin: origin.origin },
    ios: {
      ...config.ios,
      bundleIdentifier: appId,
      googleServicesFile: process.env.GOOGLE_SERVICES_IOS || "./GoogleService-Info.plist",
      associatedDomains: [`applinks:${origin.host}`],
    },
    android: {
      ...config.android,
      package: appId,
      googleServicesFile: process.env.GOOGLE_SERVICES_ANDROID || "./google-services.json",
      intentFilters: [{ action: "VIEW", autoVerify: true, category: ["BROWSABLE", "DEFAULT"],
        data: [{ scheme: "https", host: origin.hostname, path: "/invite" }] }],
    },
    plugins: [
      ...config.plugins,
      ["expo-build-properties", { ios: { useFrameworks: "static" } }],
      ["@react-native-firebase/app", { ios: { disableSPM: true } }],
      "./with-ios-auth",
      "@react-native-firebase/auth",
      "react-native-nitro-google-signin",
      ["expo-camera", { cameraPermission: "Allow Kitchen to scan a household invite.", recordAudioAndroid: false }],
    ],
  };
};
