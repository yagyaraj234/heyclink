# Native household sign-in

The existing Expo Go demo starts with the default configuration. Build a development client for Google, SMS OTP, and deep links.

1. Register native Android and iOS apps with ID `com.yagyaraj.kitchen` in the same Firebase project as the API. Enable Google and Phone in Firebase Auth. Configure SMS billing and the region policy for India.
2. Put `google-services.json` and `GoogleService-Info.plist` in `mobile/`. Set `GOOGLE_SERVICES_ANDROID` and `GOOGLE_SERVICES_IOS` if the files live outside the app directory. Keep the two local files out of git. Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` if the Firebase files do not provide the Google web OAuth client ID automatically.
3. Register the debug and release signing fingerprints in Firebase. Turn on APNs if using silent app verification for iOS phone auth. Test the reCAPTCHA fallback on both platforms.
4. From `mobile/`, export `EXPO_PUBLIC_AUTH_MODE=firebase`, `EXPO_PUBLIC_API_URL=https://api.example.com`, and `EXPO_PUBLIC_INVITE_ORIGIN=https://api.example.com` with your actual domains. Build the app with `pnpm exec expo run:android` or `pnpm exec expo run:ios`, or use a signed Expo development build. The API needs the same invite origin and the matching Android certificate fingerprints and iOS team/bundle ID.
5. On two devices, try Google and phone sign-in, link both methods from **Sign-in methods**, join two households as one cook, and send a voice note to each. Test QR scanning, the same invite link while signed out, and manual code entry. Cancel an invite and remove a cook from one household while keeping the other membership. Before App Store submission, check Apple's login and account-deletion requirements.

Existing owners can recover on a device with their old saved owner credential. Sign in with phone or link a phone in **Sign-in methods**, then choose **Recover existing household**. Invite the cook again after recovery.
