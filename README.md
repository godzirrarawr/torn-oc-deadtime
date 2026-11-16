# Torn OC Deadtime

Userscript for Torn's faction Crimes tab. It shows deadtime on each organized crime card, puts a red border on the best crime to join, can hide crimes outside your chosen OC levels, and stops you joining a slot below the faction minimum CPR.

No API key needed. The script only reads the crime list Torn's own page loads, and it never clicks or joins anything for you.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [torn-oc-deadtime.user.js](https://raw.githubusercontent.com/godzirrarawr/torn-oc-deadtime/main/torn-oc-deadtime.user.js) and click Install.

Works in Tampermonkey, Violentmonkey and [TornPDA](https://www.tornpda.com/) (set injection time to **Start**).

Faction minimum CPRs come from the faction dashboard when it reports them; otherwise from the list at the top of the script, and failing that the default (shown as a grey "≥75?"). The default level range and the dashboard URL are also set at the top of the script.

## Thanks

Beta testers:
- [Raging_Raven [2482622]](https://www.torn.com/profiles.php?XID=2482622)
- [SpitefulHorse [3907936]](https://www.torn.com/profiles.php?XID=3907936)
