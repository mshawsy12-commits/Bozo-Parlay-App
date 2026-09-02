# Bozo Parlay — setup guide (operational build)

Same idea as before — a plain website, no build step, installable to your
home screen — but now with real accounts: each of the six of you signs up
once, and from then on can only edit your own picks. Mike can edit anyone's
(so mistakes are fixable without deleting the whole thing).

Total time: ~20 minutes, no cost.

---

## 1. Create a free Firebase project

1. Go to https://console.firebase.google.com, sign in with any Google account.
2. **Add project** → name it (e.g. `bozo-parlay`) → Analytics can stay off → **Create project**.
3. Left sidebar → **Build → Firestore Database → Create database** → **production mode** → pick a region → **Enable**.
4. Firestore → **Rules** tab → replace everything with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       function isSignedIn() { return request.auth != null; }

       function isOwner(name) {
         return exists(/databases/$(database)/documents/claims/$(name)) &&
                get(/databases/$(database)/documents/claims/$(name)).data.uid == request.auth.uid;
       }

       function isAdmin() {
         return isOwner('Mike');
       }

       match /meta/{docId} {
         allow read: if true;
         allow write: if isSignedIn();
       }

       match /claims/{name} {
         allow read: if true;
         allow create: if isSignedIn() && request.resource.data.uid == request.auth.uid;
         allow update, delete: if false;
       }

       match /weeks/{weekId} {
         allow read: if true;
         allow create: if isSignedIn();
         allow update: if isSignedIn() && (
           request.resource.data.stake == resource.data.stake ||
           isAdmin() ||
           (resource.data.bozo != null && isOwner(resource.data.bozo))
         );
         allow delete: if false;

         match /picks/{name} {
           allow read: if true;
           allow write: if isSignedIn() && (isOwner(name) || isAdmin());
         }

         match /votes/{voterName} {
           allow read: if true;
           allow write: if isSignedIn() && isOwner(voterName);
         }
       }
     }
   }
   ```

   Click **Publish**. This is what actually enforces "only edit your own picks" —
   it's not just a UI restriction, so it holds even if someone pokes at the
   browser console.

5. Left sidebar → **Build → Authentication → Get started**. On the **Sign-in method**
   tab, enable **Email/Password** (the top option in the list) → **Save**.

   > The app never shows anyone an "email" field — everyone just enters their
   > name and a password. Behind the scenes it turns your name into a fake
   > address like `mike@bozoparlay.local` for Firebase's sake. Nobody needs to
   > know that, and no real email is ever sent anywhere.

6. Project Settings (gear icon) → **General** → scroll to **Your apps** → click
   **`</>`** → nickname it → **Register app** (skip Hosting).
7. Copy the `firebaseConfig` object shown, paste it into `firebase-config.js`
   in place of the six `PASTE_YOUR_...` placeholders.

---

## 2. Put it on GitHub Pages

1. Create a repo (e.g. `bozo-parlay`) — needs to be **public** for free GitHub
   Pages on a personal account.
2. From this folder:

   ```bash
   git init
   git add .
   git commit -m "Bozo Parlay dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-username>/bozo-parlay.git
   git push -u origin main
   ```

3. Repo → **Settings → Pages** → Source: **Deploy from a branch**, branch
   `main`, folder `/ (root)` → Save.
4. Wait a minute, refresh — you'll get a URL like:

   ```
   https://<your-username>.github.io/bozo-parlay/
   ```

That's the link to share with the group.

---

## 3. First-time setup for each person

1. Open the link. You'll land on a **Sign Up / Log In** screen.
2. First time: tap **Sign Up**, pick your name from the dropdown (only
   unclaimed names show up), set a password (6+ characters, doesn't need to
   be anything special), confirm it, **Create account**. That name is now
   permanently tied to that account.
3. After that, everyone just **Log In** with their name + password.
4. **Mike** is hardcoded as the admin in the rules above — his account can
   edit anyone's pick. Everyone else can only touch their own.

**Forgot a password?** There's no "forgot password" flow built in. Easiest
fix: in the Firebase console, go to **Authentication → Users**, delete that
person's account, then go to **Firestore → claims**, delete the doc with
their name, and they can sign up again fresh.

---

## 4. Install it like an app

- **iPhone (Safari)**: Share icon → **Add to Home Screen**.
- **Android (Chrome)**: ⋮ menu → **Add to Home screen** / **Install app**.

---

## 5. Using it

- Roster, the 18-week season, and playoff rounds are seeded automatically
  the first time anyone signs in.
- **+ New Betslip** adds an extra named round — appears for everyone live.
- Cards show the scheduled kickoff time instead of "Pending" until the game
  starts. **Double-click a card** to edit it (double-click again to close);
  cards you can't edit show a "view only" tag instead of the edit affordance.
- The 🔑 button adds a free [The Odds API](https://the-odds-api.com) key for
  score grading; without one it falls back to ESPN's public scoreboard.
  "Check Score" also auto-refreshes every 25 seconds for anything still
  pending.
- **🗳️ Bozo Vote** pops up automatically Tuesday through Thursday noon if
  there are unresolved losses that week — everyone votes for who should wear
  the hat, and "Crown Bozo" locks in whoever's leading.
- **This week's parlay** banner at the top shows the stake, combined odds
  (all six picks multiplied together, since it's one parlay), and the
  potential payout. The stake ($20 by default) can only be edited by that
  week's crowned Bozo or by Mike — enforced by the security rules above, not
  just hidden in the UI.
- **Season Standings** has the win/loss/units leaderboard, a "Reigning Bozo"
  callout, and a Player History dropdown — pick one person or "All players"
  for a week-by-week grid.

Multiple people can have it open at once; picks, votes, and new betslips
sync live to everyone.
