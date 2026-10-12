# Testing the HVAC Field Assistant

Thanks for helping test. This page is everything you need: how to get in, what to try, and how to tell
us when something breaks.

## 1. Get in (5 minutes)

You should have received three things from the owner: an **address**, a **username** (your name) and a
**password**.

1. If the address ends in `.ts.net`, install **Tailscale** on your phone first (App Store / Play Store),
   sign in with the account the owner invited, and leave it switched on. Skip this if the address is a
   normal `https://` link.
2. Open the address in **Safari** (iPhone) or **Chrome** (Android). A login box appears: enter your
   username and password.
3. Add it to your home screen so it works like an app:
   - iPhone: tap **Share** → **Add to Home Screen**.
   - Android: browser menu (⋮) → **Install app**.
4. Open the app from the home screen, go to **Settings → Access password**, paste your password and
   tap **Save connection**. You will not be asked again on that phone.

Lost the password? Ask the owner; they can make you a new one in a few seconds.

## 2. What you are looking at

A troubleshooting assistant for commercial HVAC and refrigeration. The tabs:

- **Chat**: describe a problem, attach nameplate or gauge photos, get a diagnostic walkthrough.
- **Units**: the equipment list. Add one by typing a model and serial (it decodes manufacturer,
  tonnage, refrigerant and age) or scan a QR label.
- **Readings**: pressure/temperature calculators (superheat, subcooling, PT chart). These work with
  no signal.
- **History**: your past chats. You only see your own; the owner sees everyone's.
- **Settings**: your test account card shows today's spend and your daily budget.

## 3. What to try

Use it the way you would on a real call. Some ideas:

- Decode a real nameplate (photo or typed). Did it get the manufacturer, tonnage and refrigerant right?
- Describe a fault you have actually seen: low suction, high head, tripping on high pressure, a
  compressor that hums and trips. Does it ask for the right readings and reach a sensible cause?
- Enter real gauge readings on the Readings tab and check the superheat / subcooling against your own
  numbers.
- Try it with one bar of signal, in airplane mode, and after the phone sleeps mid-answer.
- Try to break it: very long messages, several photos at once, rapid taps on Send, rotating the phone.

## 4. Budget

Each tester has a daily spending cap (shown in **Settings → Test account**). Every chat answer costs
the owner real money, so the app refuses new chats once you hit the cap and tells you so. It resets
after midnight on the server's clock. Calculators, units and history never count against it.

## 5. When something goes wrong

Send the owner a message with:

1. What you did (the tab, what you typed or tapped).
2. What you expected.
3. What happened instead, with a **screenshot** if there was an error banner.
4. Phone and browser (for example "iPhone 15, Safari", "Pixel 8, Chrome").

Wrong technical answers are the most valuable reports: say what the assistant claimed and what is
actually true. The owner can see your chat on their side, so mention the chat title or roughly when.

## 6. Safety

This is a test. The assistant decodes nameplates from a knowledge base and reasons over readings you
type in; it can be wrong. Never bypass safeties, charge without a leak check, or work energized
equipment on its say-so. Confirm anything marked "verify on nameplate" against the unit.
