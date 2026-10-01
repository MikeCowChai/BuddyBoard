# BuddyBoard: synchronisatie instellen (eenmalig, ±10 minuten)

Vanaf versie 2.0.0 staan alle gegevens in een gedeelde online database ([Supabase](https://supabase.com),
open source). Elke telefoon of computer die inlogt ziet dezelfde gegevens, live. Zonder internet
blijft de app gewoon werken; wijzigingen worden bewaard en verstuurd zodra er weer verbinding is.

## 1. Supabase-project aanmaken
1. Ga naar <https://supabase.com> → **Start your project** → **Continue with GitHub**.
2. **New project** → naam bijv. `buddyboard`, kies een sterk database-wachtwoord (bewaar het),
   regio dichtbij (bijv. *Southeast Asia (Singapore)*) → **Create new project**. Wacht tot hij klaar is.

## 2. Database klaarzetten
1. Links in het menu: **SQL Editor** → **New query**.
2. Plak de volledige inhoud van [`supabase/schema.sql`](supabase/schema.sql).
3. Pas **helemaal onderaan** de twee e-mailadressen aan naar die van jou (`admin`) en je compagnon (`member`).
4. Klik **Run**. (Je mag dit later opnieuw draaien, bijv. om iemand toe te voegen.)

## 3. Accounts maken
1. **Authentication → Users → Add user → Create new user**.
2. Vul jouw e-mail + een wachtwoord in, vink **Auto Confirm User** aan → **Create user**.
   Doe hetzelfde voor je compagnon. (Precies dezelfde e-mailadressen als in stap 2.)
3. Aanrader: **Authentication → Sign In / Providers** → zet **Allow new users to sign up** uit,
   zodat niemand anders een account kan maken. (Ook mét account komt alleen wie in de teamlijst
   staat bij de gegevens.)

## 4. App koppelen
1. **Project Settings → API** (of de knop **Connect** bovenaan).
2. Kopieer de **Project URL** en de **anon / publishable key**.
3. Zet die in [`supabase-config.js`](supabase-config.js) — of stuur ze naar Claude, dan doet die het.
   Deze twee zijn bedoeld om openbaar te zijn. Gebruik **nooit** de `service_role`/secret key.

## 5. Gegevens overzetten
1. Open BuddyBoard op de telefoon waar je huidige gegevens op staan via het nieuwe adres
   `https://mikecowchai.github.io/BuddyBoard/` (het oude `/v2/`-adres stuurt automatisch door).
2. Log in. De app vraagt: *"This device still has its own data … Upload it?"* → **Upload**.
3. Log op de andere telefoon(s) en de computer in — alles staat er.
4. Verwijder het oude BuddyBoard-icoon van je homescreen en zet de app opnieuw op je homescreen
   vanaf het nieuwe adres (Chrome-menu ⋮ → *Toevoegen aan startscherm* / *App installeren*).

Lukt het overzetten niet automatisch? Zet dan je backup terug via *Settings → Import backup…*.

## Goed om te weten
- **Pauze bij niet-gebruik:** een gratis Supabase-project wordt gepauzeerd als het een week niet
  gebruikt is. Je gegevens blijven bewaard; in het Supabase-dashboard klik je op **Restore project**.
- **Uitloggen** (Settings → Sign out) wist de kopie op dat apparaat; na opnieuw inloggen komt alles terug.
- **Backup:** *Settings → Export all data* blijft werken — handig om af en toe te doen.

## Admin en member
- **admin** mag alles.
- **member** doet het dagelijkse werk (orders, klanten, producten, voorraad, uitgaven invoeren),
  maar kan de winstverdeling, uitbetalingen/buffer, het banksaldo, de bonvoettekst, terugbetalen,
  backups importeren en hernummeren niet veranderen. De database controleert dit zelf.
- Rol wijzigen: Supabase → SQL Editor →
  `update public.team set role = 'member' where email = '…';` (of `'admin'`).
  Op het apparaat geldt de nieuwe rol na één keer verversen.
- Bestaand project van vóór 2.4.0: voer eenmalig [`supabase/upgrade-2.4.0-roles.sql`](supabase/upgrade-2.4.0-roles.sql) uit
  (zet onderaan het e-mailadres van je compagnon).

## Versienummers
`MAJOR.MINOR.PATCH`, te zien onderaan in *Settings*:
- **2.0.1** — kleine reparatie
- **2.1.0** — nieuwe functie
- **3.0.0** — grote verandering
