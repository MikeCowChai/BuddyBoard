# BuddyBoard: synchronisatie instellen (eenmalig, ±10 minuten)

Vanaf versie 2.0.0 staan alle gegevens in een gedeelde online database (Firebase van Google).
Elke telefoon of computer die inlogt ziet dezelfde gegevens, live. Zonder internet blijft de
app gewoon werken; wijzigingen worden gesynchroniseerd zodra er weer verbinding is.

## 1. Firebase-project aanmaken
1. Ga naar <https://console.firebase.google.com> en log in met je Google-account.
2. **Create a project** → naam bijv. `buddyboard` → Google Analytics mag uit → **Create**.

## 2. Database aanzetten
1. Links in het menu: **Build → Firestore Database** → **Create database**.
2. Kies een locatie dichtbij (bijv. `asia-southeast1` voor Thailand/Singapore) — dit kan later niet meer veranderd worden.
3. Kies **Start in production mode** → **Create**.
4. Open het tabblad **Rules**, vervang alles door de inhoud van [`firestore.rules`](firestore.rules)
   en vul daarin **jullie twee e-mailadressen** in (kleine letters). Klik **Publish**.

## 3. Inloggen aanzetten en accounts maken
1. **Build → Authentication** → **Get started** → **Email/Password** → aanzetten → **Save**.
2. Tabblad **Users** → **Add user** → jouw e-mail + wachtwoord. Doe hetzelfde voor je compagnon.
   (Gebruik precies dezelfde e-mailadressen als in de rules van stap 2.)

## 4. App koppelen
1. Tandwiel (⚙) linksboven → **Project settings** → onderaan bij *Your apps* het **`</>`** (Web) icoon.
2. Naam bijv. `buddyboard-web` → **Register app** (Firebase Hosting hoeft niet).
3. Je ziet een stukje code met `const firebaseConfig = { apiKey: "...", ... }`.
   Zet die waarden in [`firebase-config.js`](firebase-config.js) — of stuur ze naar Claude, dan doet die het.
   (Deze waarden zijn niet geheim; de beveiliging zit in het inloggen + de rules.)

## 5. Gegevens overzetten
1. Open BuddyBoard op de telefoon waar je huidige gegevens op staan, via het **nieuwe adres** (zonder `/v2/`).
   Het oude `/v2/`-adres stuurt automatisch door.
2. Log in. De app vraagt: *"This device still has its own data … Upload it?"* → **Upload**.
3. Klaar. Log op de andere telefoon(s) en op de computer in — alles staat er.

Lukt het overzetten niet automatisch? Maak dan in de oude versie een backup (*Settings → Export all data*)
en zet die in de nieuwe versie terug via *Settings → Import backup…*.

## Versienummers
`MAJOR.MINOR.PATCH`, te zien onderaan in *Settings*:
- **2.0.1** — kleine reparatie
- **2.1.0** — nieuwe functie
- **3.0.0** — grote verandering
