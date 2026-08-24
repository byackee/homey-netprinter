import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PART_CAPABILITY,
  SUPPLY_CAPABILITY,
  TRAY_CAPABILITY,
  WASTE_CAPABILITY,
  isSupplyCapability,
  trayCapability,
} from '../lib/supply-capabilities.mjs';
import { colourName, partName, trayName } from '../lib/supply-titles.mjs';
import type { SupplyColour } from '../lib/printer-mib.mjs';

describe('isSupplyCapability', () => {
  /**
   * Two things lean on this and both fail quietly if it lies.
   *
   * The Flow picker for "a supply is below a level" is filtered with it, so a
   * version that answers false offers the user an empty list and the card
   * becomes unusable. And stale-row removal is gated on it, so a version that
   * answers false leaves a replaced cartridge's row on the device for ever.
   * Neither raises anything; both just look like the app doing nothing.
   */
  it('recognises every level capability, whatever the sub-id', () => {
    for (const id of [
      `${SUPPLY_CAPABILITY}.black`,
      `${SUPPLY_CAPABILITY}.black_1_2`,
      `${WASTE_CAPABILITY}.1_3`,
      `${PART_CAPABILITY}.1_5`,
      `${TRAY_CAPABILITY}.1`,
      SUPPLY_CAPABILITY,
      TRAY_CAPABILITY,
    ]) {
      assert.ok(isSupplyCapability(id), `${id} should be a level capability`);
    }
  });

  it('does not claim a capability it does not own', () => {
    // A false positive here removes a row the app had just written, every poll.
    for (const id of [
      'onoff', 'printer_status', 'printer_message', 'printer_alert',
      'alarm_supply_low', 'alarm_paper_low', 'alarm_problem', 'alarm_open',
      'meter_pages', 'printer_output_tray',
      // The pre-1.1.0 ids: migration owns those, not stale-row removal.
      'supply_black', 'supply_other_1', 'printer_tray_1',
    ]) {
      assert.equal(isSupplyCapability(id), false, `${id} must not be claimed`);
    }
  });

  it('matches on the base id, not a prefix', () => {
    // `measure_supplies.x` is not ours. Splitting on the dot is what makes the
    // difference between a base and something that merely starts alike.
    assert.equal(isSupplyCapability('measure_supplyx.black'), false);
    assert.equal(isSupplyCapability('measure_trayed.1'), false);
  });

  it('numbers trays from one, matching the ids the old scheme used', () => {
    assert.equal(trayCapability(1), 'measure_tray.1');
    assert.equal(trayCapability(4), 'measure_tray.4');
  });
});

describe('the words for rows the printer does not name', () => {
  /**
   * New surface the migration created. Before 1.1.0 every colour was its own
   * capability and Homey supplied these words from the manifest; one capability
   * with a sub-capability per colour has a single title between them all, so
   * without these every consumable on the device reads "Supply".
   */
  it('names every colour a supply can be classified as, in all three languages', () => {
    const colours: SupplyColour[] = [
      'black', 'photo_black', 'matte_black', 'grey',
      'cyan', 'magenta', 'yellow', 'light_cyan', 'light_magenta',
      'red', 'green', 'blue', 'orange', 'waste',
    ];
    for (const colour of colours) {
      const name = colourName(colour);
      assert.ok(name !== null, `${colour} has no name`);
      for (const lang of ['en', 'fr', 'nl'] as const) {
        assert.ok(name[lang].length > 0, `${colour} has no ${lang} name`);
      }
    }
  });

  it('translates rather than repeating the English', () => {
    // The retired definitions once shipped with the English string in all three
    // slots, which reads as translated and is not.
    const black = colourName('black');
    assert.deepEqual(black, { en: 'Black', fr: 'Noir', nl: 'Zwart' });
  });

  it('has no word for a colour it cannot name, so the caller falls back', () => {
    // `other` is what an unnamed part classifies as. Returning a name for it
    // would put "Other" on a fuser instead of "Supply 3".
    assert.equal(colourName('other'), null);
  });

  it('numbers unnamed parts and trays distinctly per language', () => {
    assert.deepEqual(partName(3), { en: 'Supply 3', fr: 'Consommable 3', nl: 'Verbruiksartikel 3' });
    assert.deepEqual(trayName(2), { en: 'Tray 2', fr: 'Bac 2', nl: 'Lade 2' });
  });
});
