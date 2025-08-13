import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class HotspotPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow) {
        // Create a new preferences page
        const page = new Adw.PreferencesPage();
        window.add(page);

        // Create a new preferences group
        const group = new Adw.PreferencesGroup({
            title: _('Device Settings'),
            description: _('Configure the Bluetooth device to connect to.'),
        });
        page.add(group);

        // Create a new preferences row for the Bluetooth address
        const bluetoothRow = new Adw.ActionRow({
            title: _('Bluetooth MAC Address'),
            subtitle: _('e.g., 00:11:22:33:44:55'),
        });
        group.add(bluetoothRow);

        const bluetoothEntry = new Gtk.Entry({
            placeholder_text: _('00:11:22:33:44:55'),
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        bluetoothRow.add_suffix(bluetoothEntry);
        bluetoothRow.activatable_widget = bluetoothEntry;

        const wifiRow = new Adw.ActionRow({
            title: _('Wi-Fi SSID'),
            subtitle: _('e.g., MyWiFiNetwork'),
        });
        group.add(wifiRow);

        const wifiEntry = new Gtk.Entry({
            placeholder_text: _('MyWiFiNetwork'),
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        wifiRow.add_suffix(wifiEntry);
        wifiRow.activatable_widget = wifiEntry;

        // Create a Gio.Settings instance for your extension schema
        // Make sure the schema_id matches your XML schema filename (without .xml)
        const settings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.gnome-hotspot-toggle' });

        // Bind the entry text to the 'bluetooth-address' GSettings key
        settings.bind('bluetooth-address', bluetoothEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('wifi-ssid', wifiEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
    }
}
