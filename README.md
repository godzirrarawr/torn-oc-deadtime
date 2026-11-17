# Torn OC Deadtime

Userscript for Torn's faction Crimes tab. It shows deadtime on each organized crime card, puts a red border on the best crime to join, can hide crimes outside your chosen OC levels, and stops you joining a slot below the faction minimum CPR.

No API key needed. The script only reads the crime list Torn's own page loads, and it never clicks or joins anything for you.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [torn-oc-deadtime.user.js](https://raw.githubusercontent.com/godzirrarawr/torn-oc-deadtime/main/torn-oc-deadtime.user.js) and click Install.

Works in Tampermonkey, Violentmonkey and [TornPDA](https://www.tornpda.com/) (set injection time to **Start**).

Faction minimum CPRs come from the faction dashboard when it reports them; otherwise from the list at the top of the script, and failing that the default (shown as a grey "≥75?"). The default level range and the dashboard URL are also set at the top of the script.

## What it does and doesn't do

- **No requests to Torn.** It only reads the crime list that Torn's own page loads when you open the faction Crimes tab yourself. It never loads or scrapes other pages.
- **No automation.** It never clicks, joins or acts for you. The CPR warning only stops a JOIN click; to join anyway you click Torn's JOIN yourself.
- **No API key.** It doesn't ask for one or use one.
- **Nothing stored or sent.** Your level range and "hide others" choice are saved in your own browser (localStorage). No Torn data leaves your browser.
- **One outside request:** a plain GET to the faction's Next Crime dashboard (`http://143.198.231.254:5005/api/recommendations`), at most every 5 minutes while the Crimes tab is open and in view, for its join suggestion and the faction's minimum CPRs. It sends no key, no ID and no Torn data. Set `DASHBOARD_URL = ''` at the top of the script to turn it off.
- **Quiet in the background.** While the tab isn't in view it does nothing: no redraws, no requests, no alerts.

## Thanks

Beta testers:
- [Raging_Raven [2482622]](https://www.torn.com/profiles.php?XID=2482622)
- [SpitefulHorse [3907936]](https://www.torn.com/profiles.php?XID=3907936)
- [LightNex [3522637]](https://www.torn.com/profiles.php?XID=3522637)
