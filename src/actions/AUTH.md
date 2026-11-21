# Household authentication

Use separate databases or schemas for authenticated households and the frozen demo. Run the web demo and regression runner against an access-controlled demo deployment with synthetic notes and mock orders.

| API environment | Value |
|---|---|
| `AUTH_MODE` | `firebase` for the mobile API, `demo` for the isolated demo |
| `FIREBASE_PROJECT_ID` | Firebase project ID from the mobile app configuration |
| `GOOGLE_APPLICATION_CREDENTIALS` | Server-only path to Firebase service account credentials, if the host does not already provide Application Default Credentials |
| `INVITE_ORIGIN` | Public HTTPS origin that routes `/invite` and `/.well-known/` to this API |
| `INVITE_IOS_APP_ID` | Team ID followed by `.com.yagyaraj.kitchen` for Universal Links |
| `INVITE_ANDROID_SHA256` | Comma-separated SHA-256 fingerprints for the actual Android signing certificates |
| `INSTAMART_CREDENTIAL_KEY` | Stable 32-byte hex secret required when the authenticated API enables Instamart |

Use a secure credential store for the Firebase service account and Instamart key. Keep the Instamart key stable across replicas and restarts. Owners with old Instamart links reconnect on first use after migration.

On an existing database, owners recover via a verified Firebase phone and the saved owner credential on their phone. The claim moves ownership to the authenticated account and retires the legacy key. Cooks join again with fresh invites. Have a backup and plan assisted recovery for owners who have lost their old device or key.

The API serves invite association files when the app IDs and signing fingerprints are configured. The raw invitation code stays in the URL fragment, and manual entry uses the same code. Only active household members receive its metadata. Verify the association files and opening a shared link on signed builds before rollout.
