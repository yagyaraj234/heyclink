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
| `INSTAMART_CREDENTIAL_KEY` | Stable 32-byte hex secret for encrypted grocery account credentials |
| `ZEPTO_CLIENT_ID` | Zepto public OAuth client ID registered with `<INVITE_ORIGIN>/zepto/callback` |

Use a secure credential store for the Firebase service account and grocery credential key. Keep the key stable across replicas and restarts. Owners who linked Instamart before switching to Firebase can reconnect in Grocery accounts.

Instamart account linking uses the existing Swiggy integration settings and `/instamart/callback` on `INSTAMART_PUBLIC_ORIGIN`. For Zepto, follow the [official callback allowlist instructions](https://github.com/zeptonow/mcp#-allowed-redirect-uris), then set `ZEPTO_CLIENT_ID` for the approved public client. Zepto linking requests `tools:read` access. Owners can remove the saved connection from Grocery accounts.

On an existing database, owners recover via a verified Firebase phone and the saved owner credential on their phone. The claim moves ownership to the authenticated account and retires the legacy key. Cooks join again with fresh invites. Have a backup and plan assisted recovery for owners who have lost their old device or key.

The API serves invite association files when the app IDs and signing fingerprints are configured. The raw invitation code stays in the URL fragment, and manual entry uses the same code. Only active household members receive its metadata. Verify the association files and opening a shared link on signed builds before rollout.

## Live Firebase smoke test

Allow the country of the fictional test number under **Authentication → Settings → SMS region policy**. For India, add `IN` to the allowlist. Firebase applies the region policy to fictional numbers too.

Use a staging Firebase project, throwaway Postgres via `TEST_DATABASE_URL`, and two separate Firebase test accounts. Set `FIREBASE_PROJECT_ID` and a fresh cook ID token in `FIREBASE_TEST_ID_TOKEN` through the local environment. Set `FIREBASE_TEST_OWNER_ID_TOKEN` to a fresh ID token for a different test account to exercise household creation, single-use invites, and revocation. Use a phone-auth token for the cook to cover the phone sign-in handoff. With local Google user credentials, set `GOOGLE_CLOUD_QUOTA_PROJECT` to the test project for this process.

```sh
LIVE=1 node --env-file=.env.test --test --test-name-pattern='Firebase verifies a real mobile ID token' src/actions/auth.test.ts
```

The smoke test calls the real Firebase Admin API and uses a disposable Postgres schema. It uses synthetic note extraction and checks authorization through HTTP. Verify native Google sign-in, real SMS delivery, and QR and invite links on signed devices.
