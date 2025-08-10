import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';



const HotspotToggle = GObject.registerClass(
    class HotspotToggle extends QuickSettings.SystemIndicator {
        _init(settings) {
            super._init();

            this._settings = settings;

            this._indicator = this._addIndicator();
            this._indicator.visible = false;
            this._indicator.icon_name = 'network-wireless-hotspot-symbolic';

            const toggle = new QuickSettings.QuickToggle({
                title: _('Phone Hotspot'),
                iconName: 'network-wireless-hotspot-symbolic',
                toggleMode: true,
            });
            toggle.connect('clicked', this._toggleHotspot.bind(this));
            this.quickSettingsItems.push(toggle);

            this._setIndicatorVisibility();
        }

        _showNotification(message) {
            Main.notify('Phone Hotspot', message);
        }

        _setIndicatorVisibility() {
            const ssid = this._settings.get_string('wifi-ssid');
            const [, stdout, ,] = GLib.spawn_command_line_sync(
                `nmcli -t -f active,ssid dev wifi`
            );
            const connections = stdout ? stdout.toString().split('\n') : [];
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
                    GLib.spawn_command_line_async(`nmcli device wifi connect "${ssid}"`);
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
            } catch (e) {
                this._showNotification(_(`Error: ${e.message}`));
                this._setIndicatorVisibility();
            }
        }

        async _findBluezDevicePath(btAddress) {
            // BlueZ device object paths are like /org/bluez/hci0/dev_XX_XX_XX_XX_XX_XX
            const formatted = btAddress.replace(/:/g, '_');
            const manager = await Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.bluez',
                '/',
                'org.freedesktop.DBus.ObjectManager',
                null
            );
            const objects = manager.call_sync(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            ).deep_unpack()[0];
            for (let [path, interfaces] of Object.entries(objects)) {
                if (interfaces['org.bluez.Device1'] && path.endsWith(`dev_${formatted}`)) {
                    return path;
                }
            }
            return null;
        }

        async _bluezConnectThenDisconnectDevice(devicePath) {
            const device = await Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.bluez',
                devicePath,
                'org.bluez.Device1',
                null
            );
            const connected = device.get_cached_property('Connected')?.unpack();

            if (connected) {
                // If already connected, disconnect first, then connect
                await new Promise((resolve, reject) => {
                    device.call(
                        'Disconnect',
                        null,
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null,
                        (proxy, res) => {
                            try {
                                proxy.call_finish(res);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
                await new Promise((resolve, reject) => {
                    device.call(
                        'Connect',
                        null,
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null,
                        (proxy, res) => {
                            try {
                                proxy.call_finish(res);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                });
            } else {
                // If not connected, connect first, then disconnect
                await new Promise((resolve, reject) => {
                    device.call(
                        'Connect',
                        null,
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null,
                        (proxy, res) => {
                            try {
                                proxy.call_finish(res);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                });
                await new Promise((resolve, reject) => {
                    device.call(
                        'Disconnect',
                        null,
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null,
                        (proxy, res) => {
                            try {
                                proxy.call_finish(res);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }
                    );
                });
            }
        }

        async _handleWiFi() {
            const ssid = this._settings.get_string('wifi-ssid');
            if (this.quickSettingsItems[0].checked) {
                let connected = false;
                let count = 0;
                while (!connected && count < 5) {
                    GLib.spawn_command_line_sync(`nmcli device wifi rescan`)
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const [, , , status] = GLib.spawn_command_line_sync(
                        `nmcli device wifi connect "${ssid}"`
                    );
                    connected = status === 0;
                    count++;
                }
                if (connected) {
                    this._showNotification(_('Connected to Wi-Fi network: ') + ssid);
                }
                else {
                    this._showNotification(_('Failed to connect to Wi-Fi network: ') + ssid);
                }
            } else {
                const [, , stderr, status] = GLib.spawn_command_line_sync(
                    `nmcli device disconnect wlo1`
                );
                if (status !== 0) {
                    throw new Error(stderr ? stderr.toString() : _('Failed to disconnect from Wi-Fi.'));
                }
                this._showNotification(_('Disconnected from Wi-Fi network: ') + ssid);

                await new Promise(resolve => setTimeout(resolve, 2000));
                GLib.spawn_command_line_async(`nmcli device wifi rescan`)
                await new Promise(resolve => setTimeout(resolve, 1000));
                GLib.spawn_command_line_async(`nmcli device set wlo1 autoconnect on`)
            }
        }
    }
);

// The main extension class
export default class HotspotExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
    }

    enable() {
        // Get the settings for this extension
        this._settings = this.getSettings('org.gnome.shell.extensions.gnome-hotspot-toggle');

        // Create the toggle and pass the settings to it
        this._indicator = new HotspotToggle(this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
