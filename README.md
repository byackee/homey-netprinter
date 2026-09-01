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

### The three vendor reads, and their limits

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

Canon is the second, and it arrives by a different road. A PRO-1000 lists twelve inks
in the standard table, names every one of them, and puts a level on six. The other six
are in the status document Canon's own IJ status monitor reads — the `ivec` protocol —
held in SNMP as a table of OctetString chunks that concatenate into one XML reply.
`lib/vendors/canon.mts` splices those chunks back together in numeric OID order and
reads the levels out of them.

There is no library behind that one, so the evidence had to come from somewhere else,
and it came from the report itself. Six of that printer's twelve inks had a number in
the standard table, and the document gives the identical figure for every one of them:

```
standard   C 80   MBK 20   PBK 20   GY 80   Y 10   M 100
document   C 80   MBK 20   PBK 20   GY 80   Y 10   M 100
```

Six agreements is not a proof. It is the same reading arriving twice by two unrelated
routes, which is what makes filling the other six a fill rather than a guess — and the
three rules above still decide what happens to it.

The same document reports a maintenance cartridge, and that one is decoded, printed in
the report and deliberately left out of the capabilities. Nothing in it says whether
the number counts down as the tank fills or up as it empties, and this app has already
shipped a waste tank read backwards once: a new bottle at 0 %, with a low-supply alarm
on a healthy printer. It becomes a row when an owner says which way theirs reads.

Ricoh is the third, and it is the only one where the evidence is published. An Aficio
SP C242SF lists four cartridges and a waste bottle, names every one of them, and puts
`-3` on all five: there is toner in here and I will not say how much. Ricoh keeps the
figures in a table of its own — and unlike Brother's blob or Canon's document, Ricoh
says in its own specification what that table means: the level is a percentage of
toner remaining, `-100` is near empty, `-2` is unknown.

That sentence is what makes a single report enough. The Canon fill had to be argued
from six numbers agreeing, because nothing said which direction its levels counted;
here the manufacturer says which direction, for the object being read, so no reading
has to establish it.

What the report was still needed for is the shape, and it corrects a mistake the
public monitoring templates share. They read the table by position — first row black,
second cyan — following the example in Ricoh's own document. That printer answers
cyan first and black fourth. A fixed position would have shown its owner their cyan
level on their black cartridge, and nothing would have looked wrong until one of them
ran out. So a row is matched by the type code the printer sends, never by where it
sits.

Two consequences worth stating rather than hiding. Ricoh counts in steps of ten down
to 20 and then reports near empty for everything below; the app shows that as 10 %,
the top of the band Ricoh defines, so a low-supply alarm fires at that step and not
before — the printer's granularity, not a threshold to tune. And the waste bottle
stays blank: the toner table holds toners and says nothing about a receptacle, which
is the same answer the Canon maintenance cartridge gets, for the same reason.

No other brand needs this, and none should get it without evidence of the same kind —
a library with years of field experience behind it, a printer's own answer checked
against a reading the standard table already gave, or a manufacturer that documents
what its own numbers mean.

### When a level still reads unknown

Settings has a **Report what a printer answers** button. It reads the address, dumps
the standard supplies table, then reads the manufacturer's own branch — decoded for
the three brands whose layout is known, raw for every other — and hands back text to
paste into the [support topic](https://community.homey.app/t/158655).

That button exists because of how this gap was actually diagnosed: by asking someone
to install a command-line SNMP tool, work out its argument syntax for their platform,
and photograph the output. What came back was the wrong pages, and that was the fault
of the request. Homey is already on the same network as the printer; it can ask.

For a while it only asked on behalf of one brand, which made it useless to everyone
who still needed it. Reading an unknown branch is now bounded instead of skipped —
250 rows, 20 kB, and up to four seconds of whatever the call has left — and the report
names whichever of those it hit. A report that showed a truncated branch as a complete
one would turn "there is more down here" into "there is nothing down here". Nothing in
that section is decoded, either: a branch nobody has read has no decoder, and inventing
one from a single report is how a vendor quirk becomes a wrong reading on somebody
else's printer.

A brand *with* a decoder is read at the part that answers rather than at the top of its
branch. A Canon's whole branch opens with two hundred rows of network configuration and
its ink document sits past every cap a report can afford — which is exactly what a
Canon owner's first report did, stopping politely several hundred rows short of the one
thing it had been asked for. So a Canon report starts at the document, and prints what
that document decoded to; the whole branch is still one line in the box beside the
button for anyone who wants it. A Ricoh report starts at its toner table for the same
reason — that one branch happened to fit on the machine it was written from, and will
not on a busier one.

A report that stopped at a cap can be pointed at one branch, which is what the caps
promise its reader when they say so. That branch is read as asked whoever made the
printer — the Brother decoder reads six OIDs it already knows, which is the opposite
of what naming a branch means — and a printer whose levels sit in a document longer
than the size cap can be read a piece at a time instead of hoping the cap lands
somewhere useful.

### Ten seconds, spent once

A Homey API call is cut off at ten seconds, and the report is the one thing here that
can spend them. It very nearly did: a version negotiation, a full read, a bounded walk
and an IPP path search each had a defensible limit, and their sum did not fit. What
that cost was not a late report but no report at all, on the printers most in need of
one.

So there is one deadline, set where the call begins and passed to everything under it.
The SNMP version comes from the paired device rather than being negotiated again — on
a printer that answers only v1, negotiating costs a quarter of the budget to learn
what the settings already said, and the answer is checked against the printer anyway
if the read then fails. IPP probing is given the deadline, because looking for the
path a silent printer answers on costs one timeout per path tried. And every section
that needs the printer is raced against it in `lib/report.mts`: a section that runs
out of time says so, in the report, rather than taking the report with it.

Every report then ends with IPP, whatever the brand. A missing level is exactly the
case where nobody yet knows which protocol holds the answer, so a report covering
only the one the app happens to be reading cannot settle it. For one version that is
what happened: 1.3.0 added the section and left it reachable by a single brand, so
the reports most worth having were the ones without it. The order of a report now
lives in one place with one exit — `lib/report.mts` — and the IPP read is started
alongside the manufacturer's branch rather than after it, because ten seconds is the
whole budget and the branch walk may spend four of them.

### The second protocol

Everything above is SNMP, and where a printer implements the Printer-MIB properly
there is nothing else to want: the MIB carries alerts, covers, media names and a
lifetime page count that IPP models poorly or not at all.

The problem was never depth. It was that Homey's discovery watches `_ipp._tcp` —
every printer this app *finds*, it finds by IPP — and the driver then refused to
pair it unless it also answered SNMP, which more and more printers ship with
switched off. The app was discovering printers over one protocol and declining to
read them over it.

Since 1.3.0 it reads both, under one rule, the same one the vendor branch follows:

- **A row the standard table numbered keeps the standard number.** IPP fills only
  what came back `-1`, `-2` or `-3`.
- **A printer with no supplies table at all gets IPP's rows outright**, because the
  alternative is the blank screen its owner has been looking at.
- **A printer with no SNMP is paired and polled over IPP alone.** Levels, paper,
  status and the printer's own reasons for having stopped. No page count: IPP
  defines no printer-level impression counter, and an invented one would be an
  unknown dressed as a reading.
- **The page says which is which** — `read over IPP` next to the level, distinct
  from `manufacturer value`.

IPP also carries the one thing the Printer-MIB does not define at all: a firmware
version. `printer-firmware-string-version` is standard, so a printer of any brand may
answer it, and where it does not there are two vendor OIDs — Brother's and Canon's —
that owners' reports have shown answering. A brand nobody has reported shows nothing
rather than a guess. It is a device setting rather than a capability: a string that
changes when someone updates the printer has no business with an Insights graph.

The SNMP version is treated the same way — as something the printer decides, not
something the device knows. Pairing negotiates it, and a printer that changes under an
already-paired device looks exactly like one that has stopped answering: same timeout,
same grey tile, same repair screen, on a printer that is switched on and answering
anything that asks it correctly. Before marking a device unreachable, the app asks
once more which version answers.

What it asks matters as much as that it asks. The question used to be a single GET of
`sysDescr`, and a printer can answer that on a version it cannot be read on: a Brother
in the support topic replies to it over v2c and times out on every table walk. One
question, answered on the wrong version, was enough to move a working device onto it —
its owner set v1 by hand twice and found it back on v2c both times. So `probeVersions`
asks each version two things, whether it replies and whether it can walk a table, and
the walk stops at the first row because whether a table can be walked at all is settled
by one round trip. Between two versions that both reply, the one that can read wins.

And a paired device only moves on a strict improvement. Pairing has nothing to lose and
takes anything that answers; a device already set correctly has a working setting,
possibly one its owner corrected by hand, and "the other version also replied" is no
reason to overwrite it. Silence on one side and answers on the other still is, which is
the case this was written for.

The two are closer than they look. IPP's supply levels use the same sentinels as
RFC 3805 — -1 unavailable, -2 unknown, -3 present but unquantified — so the
arithmetic in `supplyPercent` applies unchanged. This is a second way of asking the
same question, not a second model of a printer.

`lib/ipp-client.mts` is the wire: encode, one HTTP round trip, decode. No
dependency — IPP's encoding is a tag, a name, a length and a value, repeated, and
every published library wraps it in a transport stack Homey does not need.
`lib/ipp-printer.mts` is what the answer means, and touches no socket.

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
between wireless clients. The sweep is what makes the app work there regardless.
mDNS says a printer is *there*; only SNMP says it can be *read*, so discovery results
are confirmed over SNMP before being offered.

The sweep's own confirmation is thinner than that, and used to be trusted further than
it deserved. It speaks v2c to 254 addresses at once and records what answered, which is
all it can afford — asking each address to walk a table as well would turn a search into
a minute of waiting. But answering a v2c question is not the same as being readable over
v2c, and the pairing screen created the device with whatever the sweep recorded. A
Ricoh's diagnostic report showed the whole of it in four log lines: found over v2c,
adopted, created, nothing in between. Tapping a found printer now probes that one
address properly first — affordable there, because it is one machine and its owner is
waiting on it.

### Flow cards

- **Trigger** — a supply runs low (fires on the crossing, not on every check);
  the status changes; pages have been printed; the printer reports an error.
- **Condition** — a supply is below a level.
- **Action** — read the printer now.

## Requirements

- The printer must be reachable from Homey on the local network.
- The printer must answer either SNMP or IPP. SNMP is preferred and carries more,
  with the read community `public`; a printer with SNMP switched off is paired and
  read over IPP instead, which every AirPrint or Mopria printer speaks.
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
