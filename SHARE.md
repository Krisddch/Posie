# Share to Posie in one tap (from Pinterest, Safari, Instagram…)

## iPhone / iPad: a free Shortcut (no app needed)

iOS only lets real App Store apps add themselves to the share sheet, so we use a Shortcut, which is free and takes 2 minutes.

1. Open the **Shortcuts** app → **+** (new shortcut) → rename it **Add to Posie**.
2. Tap the **ⓘ** (or the name at the top) → turn on **Show in Share Sheet**.
   Set what it receives to **URLs** and **Text** (turn the others off).
3. In the action bar, the first block says *Receive URLs and Text from Share Sheet*. Leave it.
4. Add the action **URL Encode** (input: *Shortcut Input*).
5. Add the action **Open URLs** and type:
   `https://krisddch.github.io/Posie/?add=` then insert the **URL Encoded Text** variable right after it.
6. Done.

Now in Pinterest: open a pin → **Share** → scroll the app row → **More** → **Add to Posie**.
(Tip: in that list tap **Edit** and add *Add to Posie* to Favorites so it's always first.)

Posie opens and the pin's picture lands in the middle of your board, with its title and a link back to the pin.

> Heads-up: on iPhone, a Posie added to the Home Screen keeps its own storage, separate from Safari.
> The Shortcut opens Safari. Sign in (tap **posie** → email link) in both and they share one board.

## Android: built in

Open Posie in Chrome → menu → **Install app** (or *Add to Home screen*). Posie now appears in the normal **Share** menu.

## Turning on link previews (needed for Pinterest)

Pinterest shares a link to the pin, not the picture. A tiny function in your Supabase project reads the link and finds the picture and title.

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly **unfurl**, paste everything from [`supabase/functions/unfurl/index.ts`](supabase/functions/unfurl/index.ts), click **Deploy**.
3. Open the function → **Details / Settings** → turn **off "Verify JWT"** (Posie calls it before you sign in; the function only reads public web pages).

Without it, shared links are saved as link cards and direct image links still work.
