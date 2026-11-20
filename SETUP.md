# Turning on "Sign in with Apple" + sync

Posie works fully without an account. Sync needs two things only you can create:
an **Apple Developer account** (for Sign in with Apple) and a free **Supabase** project
(it stores your boards and handles the Apple login).

## 1. Supabase (≈5 min)

1. Create a project at https://supabase.com (free tier is fine).
2. **SQL Editor** → paste [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Project Settings → API**: copy the **Project URL** and the **anon public** key into [`config.js`](config.js).
4. **Authentication → URL Configuration**:
   - Site URL: `https://krisddch.github.io/Posie/`
   - Redirect URLs: add `https://krisddch.github.io/Posie/` and `http://localhost:5173/`

## 2. Apple (≈15 min, needs the paid Apple Developer Program)

In https://developer.apple.com/account/resources:

1. **Identifiers → App IDs → +**: create an App ID (e.g. `com.yourname.posie`) and tick **Sign in with Apple**.
2. **Identifiers → Services IDs → +**: create a Services ID (e.g. `com.yourname.posie.web`) — this is the *Client ID*.
   Enable **Sign in with Apple** → Configure:
   - Primary App ID: the App ID above
   - Domains: `<your-project>.supabase.co`
   - Return URL: `https://<your-project>.supabase.co/auth/v1/callback`
3. **Keys → +**: create a key with **Sign in with Apple**, download the `.p8` file, note the **Key ID** and your **Team ID**.

## 3. Connect them

Supabase → **Authentication → Sign In / Providers → Apple** → enable, then fill in the
Services ID (Client ID) and the secret Supabase asks for (it explains how to generate it from the
`.p8` key, Key ID and Team ID). Note: Apple's secret expires every 6 months and must be regenerated.

Commit `config.js`, and the "Sign in with Apple" button (tap **posie** in the top-left corner) goes live.

## How sync behaves

- Your board is always saved on the device first, so it's fast and works offline.
- After signing in, everything is merged (newest edit wins per pin), and each change is uploaded a second later.
- Coming back to the tab pulls changes from your other devices.
- Signing out keeps the board on that device; it just stops syncing.
