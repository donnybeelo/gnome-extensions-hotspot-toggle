import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

interface RunResult {
    success: boolean;
    stdout: string;
    stderr: string;
}

const HotspotToggle = GObject.registerClass(
    class HotspotToggle extends QuickSettings.SystemIndicator {
        _settings: Gio.Settings;
        _timerid: number;
        _indicator: St.Icon;
        constructor(settings: Gio.Settings) {
            super();

            this._settings = settings;

            this._indicator = this._addIndicator();
            this._indicator.visible = false;
            this._indicator.icon_name = 'network-wireless-hotspot-symbolic';
            this._timerid = 0;

            const toggle: QuickSettings.QuickToggle = new QuickSettings.QuickToggle({
                title: _('Phone Hotspot'),
                iconName: 'network-wireless-hotspot-symbolic',
                toggleMode: true,
            });
            toggle.connect('clicked', this._toggleHotspot.bind(this));
            this.quickSettingsItems.push(toggle);

            this._setIndicatorVisibility()
        }

        _showNotification(message: string): void {
            Main.notify('Phone Hotspot', message);
        }

        async _run(command: string[]): Promise<RunResult> {
            // Minimal wrapper around Gio.Subprocess returning { success, stdout, stderr }
            return await new Promise<RunResult>((resolve, reject) => {
                let proc: Gio.Subprocess;
                try {
                    proc = Gio.Subprocess.new(command, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                } catch (e) { reject(e); return; }
                proc.communicate_utf8_async(null, null, (_p: Gio.Subprocess | null, res: Gio.AsyncResult) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        resolve({ success: proc.get_successful(), stdout: stdout || '', stderr: stderr || '' });
                    } catch (e) { reject(e); }
                });
            });
        }

        _wait(seconds: number): Promise<void> {
            if (this._timerid) {
                GLib.Source.remove(this._timerid);
            }
            return new Promise<void>(r => {
                this._timerid = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                    this._timerid = 0;
                    r();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        async _setIndicatorVisibility() {
            const ssid = this._settings.get_string('wifi-ssid');
            await this._run(['nmcli', 'device', 'wifi', 'rescan']);
            const { stdout } = await this._run(['nmcli', '-t', '-f', 'active,ssid', 'dev', 'wifi']);
            const connections = stdout ? stdout.split('\n') : [];
            let found = false;
            let connect = false;
            for (const line of connections) {
                if (line.includes(ssid)) {
                    found = true;
                    if (line.startsWith('no:')) {
                        connect = true
                    }
                    break;
                }
            }
            if (found) {
                this.quickSettingsItems[0].checked = true;
                this._indicator.visible = true;
                if (connect) {
                    await this._run(['nmcli', 'device', 'wifi', 'connect', ssid])
                    this._showNotification(_('Connected to Wi-Fi network: ') + ssid);
                }
            } else {
                this.quickSettingsItems[0].checked = false;
                this._indicator.visible = false;
            }
        }

        async _toggleHotspot() {
            this._indicator.visible = !this._indicator.visible;
            const btAddress = this._settings.get_string('bluetooth-address');
            if (!btAddress || !btAddress.match(/^([0-9A-F]{2}:){5}([0-9A-F]{2})$/i)) {
                this._showNotification(_('Bluetooth address is not configured or invalid. Check that the set Bluetooth MAC Address is in the correct format.'));
                this._setIndicatorVisibility();
                return;
            }
            try {
                // Find the BlueZ device object path for the given MAC address
                const devicePath = await this._findBluezDevicePath(btAddress);
                if (!devicePath) {
                    throw new Error(_('Bluetooth device not found. Make sure Bluetooth is enabled and the device is paired.'));
                }
                // Connect to the device if not already connected
                await this._bluezConnectThenDisconnectDevice(devicePath);

                await this._handleWiFi();
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                this._showNotification(_(`Error: ${message}`));
                this._setIndicatorVisibility();
            }
        }

        async _findBluezDevicePath(btAddress: string): Promise<string | null> {
            // BlueZ device object paths are like /org/bluez/hci0/dev_XX_XX_XX_XX_XX_XX
            const formatted = btAddress.replace(/:/g, '_');
            const manager: Gio.DBusProxy = await new Promise((resolve, reject) => {
                Gio.DBusProxy.new_for_bus(
                    Gio.BusType.SYSTEM,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.bluez',
                    '/',
                    'org.freedesktop.DBus.ObjectManager',
                    null,
                    (src, res) => {
                        try {
                            resolve(Gio.DBusProxy.new_for_bus_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            const [objects] = await new Promise<[Record<string, Record<string, unknown>>]>((resolve, reject) => {
                manager.call(
                    'GetManagedObjects',
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, res) => {
                        try {
                            resolve(proxy?.call_finish(res).deep_unpack() as [Record<string, Record<string, unknown>>]);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            for (let [path, interfaces] of Object.entries(objects)) {
                if (interfaces['org.bluez.Device1'] && path.endsWith(`dev_${formatted}`)) {
                    return path;
                }
            }
            return null;
        }

        async _bluezConnectThenDisconnectDevice(devicePath: string) {
            const device: Gio.DBusProxy = await new Promise((resolve, reject) => {
                Gio.DBusProxy.new_for_bus(
                    Gio.BusType.SYSTEM,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.bluez',
                    devicePath,
                    'org.bluez.Device1',
                    null,
                    (src, res) => {
                        try {
                            resolve(Gio.DBusProxy.new_for_bus_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            const call = (method: string) => new Promise((resolve, reject) => {
                device.call(
                    method,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, res) => {
                        try {
                            proxy?.call_finish(res);
                            resolve(undefined);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            const connected = device.get_cached_property('Connected')?.unpack();
            if (connected) {
                await call('Disconnect');
                await this._wait(2); // Wait for disconnect to complete
                await call('Connect');
            } else {
                await call('Connect');
                await call('Disconnect');
            }
        }

        async _handleWiFi() {
            const ssid = this._settings.get_string('wifi-ssid');
            if (this.quickSettingsItems[0].checked) {
                let attempt = 0, connected = false;
                while (!connected && attempt++ < 5) {
                    await this._run(['nmcli', 'device', 'wifi', 'rescan'])
                    const result = await this._run(['nmcli', 'device', 'wifi', 'connect', ssid])
                    connected = !!result?.success;
                    if (!connected) await this._wait(2);
                }
                if (connected)
                    this._showNotification(_('Connected to Wi-Fi network: ') + ssid);
                else
                    this._showNotification(_('Failed to connect to Wi-Fi network: ') + ssid);
            } else {
                await this._run(['nmcli', 'device', 'disconnect', 'wlo1'])
                this._showNotification(_('Disconnected from Wi-Fi network: ') + ssid);
                await this._run(['nmcli', 'device', 'wifi', 'rescan'])
                await this._run(['nmcli', 'device', 'set', 'wlo1', 'autoconnect', 'on'])
            }
        }
        destroy() {
            this.quickSettingsItems?.forEach(i => {
                i.destroy();
            });
            if (this._timerid) {
                GLib.Source.remove(this._timerid);
                this._timerid = 0;
            }
            this._indicator.destroy();
            super.destroy();
        }

    }
);

// The main extension class
export default class HotspotExtension extends Extension {
    settings!: Gio.Settings | null;
    indicator!: InstanceType<typeof HotspotToggle> | null;

    enable() {
        // Get the settings for this extension
        this.settings = this.getSettings('org.gnome.shell.extensions.hotspot-toggle');

        // Create the toggle and pass the settings to it
        this.indicator = new HotspotToggle(this.settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this.indicator);
    }

    disable() {
        this.indicator?.destroy();
        this.indicator = null;
        this.settings = null;
    }
}
