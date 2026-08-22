import 'source-map-support/register.js';
import Homey from 'homey';

/** The app itself owns nothing: every printer is a device, and each device polls itself. */
export default class NetworkPrinterApp extends Homey.App {
  override async onInit(): Promise<void> {
    this.log('Network Printer app initialised');
  }
}
