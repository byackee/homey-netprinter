# Network Printer for Homey

Reads ink and toner levels, status and page counts from network printers over SNMP,
and makes them available to Homey Flows.

One driver covers every brand. Everything the app reads comes from the standard
Printer-MIB (RFC 3805) and Host Resources MIB (RFC 2790), which Epson, HP, Brother,
Canon, Kyocera, Lexmark, Ricoh, OKI, Xerox and Samsung network printers all implement.
The manufacturer is detected from `sysObjectID` and used only to name the device.

## What it exposes

| Capability | Source |
|---|---|
| One level per cartridge, tank or maintenance unit | `prtMarkerSuppliesTable`, discovered by walk |
| One level per paper tray, named after its tray and paper | `prtInputTable` |
| Output tray: OK, half full, full | `prtOutputTable` plus the output error bits |
| Responding: dims the tile the moment the printer stops answering | derived from the read itself |
| Status: ready, printing, warming up, offline | `hrPrinterStatus`, `hrDeviceStatus` |
| Panel message, e.g. "Ready" | `prtConsoleDisplayBufferText` |
| Printer alerts, in the printer's own words | `prtAlertTable` |
| Lifetime page count | `prtMarkerLifeCount` |
| Supply-low alarm, naming the consumable | derived, threshold set per device |
| Paper-low alarm | `prtInputTable` plus the paper error bits |
| Cover-open alarm | `prtCoverTable` |
| Printer-error alarm | `hrPrinterDetectedErrorState`, blocking flags only |

The number of supplies is discovered, never assumed: a four-cartridge office printer
and a nine-cartridge photo printer both work without a code change. Since 1.1.0 there
is no ceiling on it either — each level is a sub-capability rather than one of a fixed
set of slots.

Almost all of it comes from the standard Printer MIB, which is why one driver serves
every brand. There is exactly one exception, and it is worth being precise about it.

An MFC-L2827DW answers `-3 / -2 tenthsOfGrams` for its toner — the Printer-MIB's way
of saying "there is some left and I will not put a number on it". That is not a
broken printer and not a broken read; it is a printer declining to answer. Everything
else it reports is read correctly, drum life included, and matches what Home
Assistant shows for the same machine to the page.

The number does exist. Brother keeps it on a private branch, packed into a single
OctetString alongside drum, belt, fuser and page counters — one OID, not the pages of
walk output this project first went looking for. Since 1.2.0 the app reads it.

### The one vendor read, and its limits

`lib/vendors/brother.mts` decodes that blob. The decoding is not this project's work:
it is Home Assistant's [`brother`](https://github.com/bieniu/brother) library, which
has been read against thousands of Brother machines over years — field experience one
app author with one printer cannot reproduce. The marker bytes, the hundredths-of-a-
percent scale and the older five-byte layout all come from there, and the tests decode
that library's own worked example to the numbers it documents.

Three rules keep this from becoming the thing the app depends on:

- **It fills gaps, never overrides.** A row the standard table numbered keeps the
  standard number. Only a row that came back `-3`, `-2` or unreadable is offered a
  vendor value.
- **An ambiguous value is dropped.** The blob names a colour and a kind of part and
  nothing else. If two rows could equally claim a reading, neither gets it.
- **The user is told which is which.** A vendor-sourced level is labelled as one in
  the settings page, next to the `-3` the printer actually sent.

No other brand needs this, and none should get it without the same kind of evidence.

### When a level still reads unknown

Settings has a **Report what a printer answers** button. It reads the address, dumps
the standard supplies table, then reads the manufacturer's own branch — decoded for
Brother, whose layout is known, raw for every other brand — and hands back text to
paste into the [support topic](https://community.homey.app/t/158655).

That button exists because of how this gap was actually diagnosed: by asking someone
to install a command-line SNMP tool, work out its argument syntax for their platform,
and photograph the output. What came back was the wrong pages, and that was the fault
of the request. Homey is already on the same network as the printer; it can ask.

For a while it only asked on behalf of one brand, which made it useless to everyone
who still needed it. Reading an unknown branch is now bounded instead of skipped —
250 rows, 20 kB, four seconds — and the report names whichever of those it hit. A
Homey API call is cut off at ten seconds, and a report that showed a truncated branch
as a complete one would turn "there is more down here" into "there is nothing down
here". Nothing in that section is decoded, either: a branch nobody has read has no
decoder, and inventing one from a single report is how a vendor quirk becomes a wrong
reading on somebody else's printer.

### Finding a printer

Two mechanisms, because neither covers everything on its own.

Homey's own mDNS discovery watches `_ipp._tcp`, which AirPrint and Mopria both
require, so essentially every current network printer announces itself on it.
Those appear in pairing instantly, and — the real prize — Homey reports when one
moves, so a DHCP lease change updates the device's address by itself instead of
leaving it unavailable until someone repairs it by hand.

A subnet sweep then covers the rest, and it is not a fallback of last resort:
on the network this was developed against, Homey itself receives no mDNS at all —
the printer advertises all three printer services and a Mac on the same subnet
sees them, but nothing reaches Homey, which points at multicast being filtered
between wireless clients. The sweep is what makes the app work there regardless. It asks each address the same SNMP question the
app will ask later, so anything it finds is by definition usable. mDNS says a
printer is *there*; only SNMP says it can be *read*, so discovery results are
confirmed over SNMP before being offered.

### Flow cards

- **Trigger** — a supply runs low (fires on the crossing, not on every check);
  the status changes; pages have been printed; the printer reports an error.
- **Condition** — a supply is below a level.
- **Action** — read the printer now.

## Requirements

- The printer must be reachable from Homey on the local network.
- SNMP must be enabled on the printer. It is on by default on nearly every
  network printer, with the read community `public`.
- Give the printer a fixed address in your router. A DHCP lease change is the
  most common reason a working device stops answering.

## Development

```sh
npm install
npm test                  # unit tests for the MIB decoding and capability mapping
npm run typecheck
npm run validate          # homey app validate --level debug
npm run validate:publish  # the stricter level the App Store applies
npm run app:run           # run against a Homey on the same network
```

`tools/probe.mts` reads a real printer straight from the command line, which is the
quickest way to see what a given model exposes before touching the app:

```sh
npx tsc -p tsconfig.tools.json && node .toolsbuild/tools/probe.mjs 192.168.1.50 public
```

### Notes for future changes

- **`app.json` at the root is generated by HomeyCompose, but the CLI reads it before
  running the generator.** It has to exist for the build to bootstrap, so it is
  committed even though it is an artefact. Edit `.homeycompose/app.json`.
- **An ESM app requires `compatibility` of at least `>=12.0.1`.** Anything lower
  fails validation with no other explanation.
- **SNMPv1 fails an entire GET when one OID is missing** (`NoSuchName`), so one
  absent page counter would cost the ink levels too. The app negotiates v2c first,
  which reports missing values per varbind, and isolates each OID into its own
  request when it has to fall back to v1.
- **Pairing results may only carry** `name`, `data`, `store`, `settings`, `icon`,
  `capabilities` and `capabilitiesOptions`. Homey rejects an entry with any other
  key by returning an empty list, silently — and the SDK types the result as
  `any[]`, so the compiler cannot catch it.
- **Never call `session.showView()` from inside the driver's `showView` handler.**
  It deadlocks: Homey waits for the handler to return before completing the
  transition while the handler waits for that transition. The pairing view calls
  `Homey.showView()` itself.
- **Printer-MIB levels of -1, -2 and -3 are sentinels**, not quantities. They mean
  other, unknown and some-remaining. Rendering them as numbers puts "-2 %" in the
  UI; rendering them as 0 raises a false empty-cartridge alarm.
- **Levels are sub-capabilities: `measure_supply.black`, `measure_part.1_5`.** Before
  1.1.0 each was a capability of its own, twenty-two definitions differing only by a
  title, with eight numbered slots for supplies the printer gave no colour — and a
  laser reporting a ninth had it dropped while the low-supply alarm still counted it.
  Three base capabilities rather than one because `icon` belongs to a capability's
  definition and is not a capability option, so every sub-capability wears its base's
  icon; a waste bottle showing the black cartridge's ink drop loses what the icon is
  for. The `measure_` prefix is what lets a user pick a level as the indicator beside
  the device icon — Homey offers only `measure_`- and `meter_`-prefixed ids there.
- **Homey revalidates a device's *entire* capability set on every `addCapability`
  and `removeCapability`.** So a capability definition cannot be deleted from the
  manifest in the same release that removes it from devices: the device still holds
  an id the app no longer defines, and every capability write on it is then refused
  — including the one that would have removed it. The migration deadlocks against
  itself, silently, and the device keeps the old rows for ever. The error names a
  *different* capability than the one being written, which is the only clue:
  `remove alarm_printer_error: Invalid Capability: supply_photo_black`. Retire a
  definition in one release, delete it in a later one, once no device can still
  hold it. `tools/generate-capabilities.mjs` keeps the retired ones alive.
- **A sub-capability's id is a permanent Insights key, so it must not renumber.**
  `Supply.index` is the printer's own table index, not a position in our list, because
  a position shifts the day a printer starts reporting one more consumable and would
  move one part's graph onto another. It is dotted in the MIB, and a second dot would
  break Homey's base-id lookup, so it is sanitised to `1_5`.
- **`removeCapability` destroys that capability's Insights history**, and adding
  it back does not restore it. A printer waking from sleep can answer some OIDs
  and not others, so removal must never be driven by a thin poll — the app only
  drops a supply row when the supplies table was read successfully, and never
  drops a scalar row at all.
- **A receptacle already reports its own headroom — never invert it.** RFC 3805
  defines `prtMarkerSuppliesLevel` as "the current level if this supply is a
  container; the *remaining space* if this supply is a receptacle", so a waste
  tank counts down as it fills, exactly like a cartridge. This app inverted it on
  the opposite assumption and showed a brand new Lexmark waste bottle reporting
  15000 of 15000 impressions of headroom as 0 %, complete with a low-supply alarm
  on a printer with nothing wrong. `prtMarkerSuppliesClass` classifies the part;
  it does not change how the number is read.

- **On a settings page, `Homey` is not a global** — it is the argument of
  `onHomeyReady(Homey)`. Code outside that function which touches Homey throws a
  ReferenceError that nothing surfaces. In a *pairing* view the opposite holds:
  `Homey` is global there.
- **A Homey API call is cut off after ten seconds.** The subnet sweep takes
  around sixteen, so the endpoint starts it and the settings page polls for
  progress; awaiting it produced a "timeout after 10000ms" in the user's face.
  Every other endpoint reads with a short timeout and no retry for the same
  reason — one unreachable printer must not push the page past the limit.
- **Do not await the first poll in `onInit`.** Homey initialises devices in
  sequence, so blocking on a sleeping printer holds up every device behind it.

## Settings page

The app's settings page reads every paired printer live, tests a single address
without pairing it, and runs the same sweep pairing uses. It exists because an
app installed with `homey app install` has no readable log: Developer Tools lists
only App Store submissions and the CLI has no log command, so without this page a
failing SNMP read is completely opaque.

## Support ❤️

This app is free, and built on my own time — evenings spent reading MIB tables so
you don't have to. If it saves you a failed print job or two, you can support the
work:

- ☕ Buy me a coffee: https://buymeacoffee.com/byackee
- 🔗 All my links: https://linktr.ee/byackee

Opening an issue with your printer's diagnostics helps just as much — every report
makes the next model work out of the box. Thank you for using it, and for every bit
of support 🙏

## Licence

MIT
