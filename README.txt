Network Printer brings your printer's ink levels into Homey.

Every cartridge appears as its own level, named after the cartridge you would
actually buy, so a low tank is something a Flow can act on rather than something
you discover halfway through printing. Status, the message on the printer's own
panel, and the lifetime page counter come along with it.

One app covers every brand. Everything it reads comes from the standard
Printer-MIB that network printers implement, so Epson, HP, Brother, Canon,
Kyocera, Lexmark, Ricoh, OKI, Xerox and Samsung all work the same way. Nothing is
hard-coded per model: the number of cartridges, their names and their colours are
discovered from the printer itself, so a four-cartridge office printer and a
nine-cartridge photo printer both work without a change.

WHAT YOU GET

- One level per cartridge or tank, titled with the cartridge's own name.
- Waste tanks reported as room left, so 100% always means nothing to do.
- Status: ready, printing, warming up, offline.
- The text on the printer's front panel.
- The lifetime page counter.
- A supply-low alarm, at a threshold you choose per printer.
- An error alarm for what actually stops printing: paper jam, out of paper, open
  cover, missing cartridge.

FLOWS

- When a supply runs low. It fires as the level crosses your threshold, once,
  rather than every time the printer is checked.
- When the status changes, optionally to one status in particular.
- When pages have been printed, carrying how many.
- When the printer reports an error.
- Whether a supply is below a level, as a condition.
- Read the printer now, as an action.

BEFORE YOU START

You need a Homey Pro. Homey Cloud and Homey Bridge cannot reach devices on your
network, so they cannot reach a printer.

SNMP must be enabled on the printer. It is on by default on nearly every network
printer, with the read community "public".

Adding the printer searches your network for you, so there is usually nothing to
type. If yours does not appear — it may be on another subnet, or use a different
community — you can add it by address instead.

Give the printer a fixed address in your router. A changed DHCP lease is the most
common reason a working printer stops answering.
