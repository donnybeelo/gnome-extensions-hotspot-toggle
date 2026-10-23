import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";

interface RunResult {
	success: boolean;
	stdout: string;
	stderr: string;
}

const GATT_SERVICE_UUID = "9ee751d0-7f57-48d0-86b9-8b5bbc12c48b";
const GATT_CHAR_UUID = "4abcc130-223c-4c15-b29f-8f2b347483b0";
const GATT_ROOT = "/net/donnybeelo/hotspot";
const GATT_SERVICE_PATH = `${GATT_ROOT}/service0`;
const GATT_CHAR_PATH = `${GATT_SERVICE_PATH}/char0`;
const GATT_ADV_PATH = `${GATT_ROOT}/advert0`;

const OBJECT_MANAGER_XML = `<node><interface name="org.freedesktop.DBus.ObjectManager">
	<method name="GetManagedObjects"><arg type="a{oa{sa{sv}}}" direction="out"/></method>
</interface></node>`;
const GATT_CHAR_XML = `<node><interface name="org.bluez.GattCharacteristic1">
	<method name="ReadValue">
		<arg type="a{sv}" direction="in"/>
		<arg type="ay" direction="out"/>
	</method>
</interface></node>`;
const GATT_ADV_XML = `<node><interface name="org.bluez.LEAdvertisement1">
	<method name="Release"/>
	<property name="Type" type="s" access="read"/>
	<property name="ServiceUUIDs" type="as" access="read"/>
</interface></node>`;

const HotspotToggle = GObject.registerClass(
	class HotspotToggle extends QuickSettings.SystemIndicator {
		menu: any;
		setSensitive: any;
		setMenu: any;
		container: any;

		_settings: Gio.Settings;
		_timerid: number;
		_indicator: St.Icon;
		_running: boolean;
		_pendingBtDevice: Gio.DBusProxy | null;
		_wasBluetoothDisabled: boolean;
		_intent: number;
		_gattExports: Gio.DBusExportedObject[];
		_gattAdapter: string;
		constructor(settings: Gio.Settings) {
			super();

			this._settings = settings;

			this._indicator = this._addIndicator();
			this._indicator.visible = false;
			this._indicator.icon_name = "network-wireless-hotspot-symbolic";
			this._timerid = 0;
			this._running = false;
			this._pendingBtDevice = null;
			this._wasBluetoothDisabled = false;
			this._intent = 0;
			this._gattExports = [];
			this._gattAdapter = "";

			const toggle: QuickSettings.QuickToggle = new QuickSettings.QuickToggle({
				title: _("Phone Hotspot"),
				iconName: "network-wireless-hotspot-symbolic",
				toggleMode: true,
			});
			toggle.connect("clicked", this._toggleHotspot.bind(this));
			this.quickSettingsItems.push(toggle);

			const macNotSet = this._settings.get_string("bluetooth-address") === "";
			const wifiNotSet = this._settings.get_string("wifi-ssid") === "";
			if (macNotSet && wifiNotSet) {
				this._showNotification(
					_(
						"No Wi-Fi SSID set & no MAC address set. Go to Extension Manager > Cogwheel next to Hotspot Toggle and set them appropriately.",
					),
				);
			} else if (wifiNotSet) {
				this._showNotification(
					_(
						"No Wi-Fi SSID set. Go to Extension Manager > Cogwheel next to Hotspot Toggle and set it appropriately.",
					),
				);
			} else if (macNotSet) {
				this._showNotification(
					_(
						"No MAC address set. Go to Extension Manager > Cogwheel next to Hotspot Toggle and set it appropriately.",
					),
				);
			} else {
				this._setIndicatorVisibility();
			}
		}

		_showNotification(message: string): void {
			Main.notify("Phone Hotspot", message);
		}

		async _run(command: string[]): Promise<RunResult> {
			// Minimal wrapper around Gio.Subprocess returning { success, stdout, stderr }
			return await new Promise<RunResult>((resolve, reject) => {
				let proc: Gio.Subprocess;
				try {
					proc = Gio.Subprocess.new(
						command,
						Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
					);
				} catch (e) {
					reject(e);
					return;
				}
				proc.communicate_utf8_async(
					null,
					null,
					(_p: Gio.Subprocess | null, res: Gio.AsyncResult) => {
						try {
							const [, stdout, stderr] = proc.communicate_utf8_finish(res);
							resolve({
								success: proc.get_successful(),
								stdout: stdout || "",
								stderr: stderr || "",
							});
						} catch (e) {
							reject(e);
						}
					},
				);
			});
		}

		_wait(seconds: number): Promise<void> {
			if (this._timerid) {
				GLib.Source.remove(this._timerid);
			}
			return new Promise<void>((r) => {
				this._timerid = GLib.timeout_add_seconds(
					GLib.PRIORITY_DEFAULT,
					seconds,
					() => {
						this._timerid = 0;
						r();
						return GLib.SOURCE_REMOVE;
					},
				);
			});
		}

		async _isConnectedToSSID(
			ssid: string,
		): Promise<{ found: boolean; connected: boolean }> {
			const { stdout } = await this._run([
				"nmcli",
				"-t",
				"-f",
				"active,ssid",
				"dev",
				"wifi",
			]);
			const connections = stdout ? stdout.split("\n") : [];
			let found = false;
			let connected = false;
			for (const line of connections) {
				if (line.includes(ssid)) {
					found = true;
					if (line.startsWith("yes:")) {
						connected = true;
					}
					break;
				}
			}
			return { found, connected };
		}

		async _setIndicatorVisibility(connectIfFound: boolean = true) {
			const ssid = this._settings.get_string("wifi-ssid");
			const { found, connected } = await this._isConnectedToSSID(ssid);
			if (connectIfFound) {
				if (found) {
					this.quickSettingsItems[0].checked = true;
					this._indicator.visible = true;
					if (!connected) {
						await this._run(["nmcli", "device", "wifi", "connect", ssid]);
						this._showNotification(_("Connected to Wi-Fi network: ") + ssid);
					}
				} else {
					this.quickSettingsItems[0].checked = false;
					this._indicator.visible = false;
				}
			}
			return found;
		}

		async _toggleHotspot() {
			if (this._running) {
				const device = this._pendingBtDevice;
				if (!device || device.get_cached_property("Connected")?.unpack()) {
					this.quickSettingsItems[0].checked =
						!this.quickSettingsItems[0].checked;
					return;
				}
				if (this._timerid) {
					GLib.Source.remove(this._timerid);
					this._timerid = 0;
				}
				this._pendingBtDevice = null;
				this._running = false;
			}

			const hotspotOn = await this._setIndicatorVisibility(false);
			const toggleOn = this.quickSettingsItems[0].checked;
			if (!toggleOn && !hotspotOn) {
				await this._handleWiFi();
				await this._restoreBluetooth();
				return;
			}

			this._running = true;
			const btAddress = this._settings.get_string("bluetooth-address");
			if (!btAddress || !btAddress.match(/^([0-9A-F]{2}:){5}([0-9A-F]{2})$/i)) {
				this._showNotification(
					_(
						"Bluetooth address is not configured or invalid. Check that the set Bluetooth MAC Address is in the correct format.",
					),
				);
				this._setIndicatorVisibility();
				this._running = false;
				return;
			}
			try {
				// Check if Bluetooth is enabled, and enable it if not
				const bluetoothStatus = await this._run(["bluetoothctl", "show"]);
				if (
					bluetoothStatus.stdout &&
					!bluetoothStatus.stdout.includes("Powered: yes")
				) {
					this._wasBluetoothDisabled = true;
					await this._run(["rfkill", "unblock", "bluetooth"]);
					await this._wait(1); // Wait for Bluetooth to fully power on
				}
				// Find the BlueZ device object path for the given MAC address
				const devicePath = await this._findBluezDevicePath(btAddress);
				if (!devicePath) {
					this._running = false;
					throw new Error(
						_(
							"Bluetooth device not found. Make sure Bluetooth is enabled and the device is paired.",
						),
					);
				}

				await this._registerIntent(
					toggleOn ? 1 : 0,
					devicePath.substring(0, devicePath.lastIndexOf("/")),
				);

				// Establish proxy to Bluetooth and find out whether
				const btDevice = await this._bluezDeviceProxy(devicePath);
				const connectedProperty = btDevice
					.get_cached_property("Connected")
					?.unpack();
				const connected = connectedProperty ? true : false;

				// Connect to the device if not already connected
				await this._bluezSetConnectedState(btDevice, !connected);
				if (connected) {
					await this._wait(2);
					await this._bluezSetConnectedState(btDevice, true);
				}
				await this._handleWiFi();
				this._pendingBtDevice = btDevice;
				await this._wait(10);
				this._pendingBtDevice = null;
				if (!connected) {
					await this._bluezSetConnectedState(btDevice, connected); // Revert Bluetooth connection state
				}

				await this._unregisterIntent();
				await this._restoreBluetooth();
				this._running = false;
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				this._showNotification(_(`Error: ${message}`));
				this._setIndicatorVisibility();
				await this._unregisterIntent();
				await this._restoreBluetooth();
				this._running = false;
			}
		}

		async _bluezAdapterCall(
			iface: string,
			method: string,
			params: GLib.Variant,
		) {
			return new Promise((resolve, reject) => {
				Gio.DBus.system.call(
					"org.bluez",
					this._gattAdapter,
					iface,
					method,
					params,
					null,
					Gio.DBusCallFlags.NONE,
					-1,
					null,
					(conn, res) => {
						try {
							resolve(conn?.call_finish(res));
						} catch (e) {
							reject(e);
						}
					},
				);
			});
		}

		// Publishes the on/off intent as a GATT characteristic the phone can read
		async _registerIntent(intent: number, adapterPath: string) {
			this._intent = intent;
			if (this._gattExports.length) return;
			this._gattAdapter = adapterPath;

			const exportObject = (path: string, xml: string, impl: object) => {
				const exported = Gio.DBusExportedObject.wrapJSObject(xml, impl);
				exported.export(Gio.DBus.system, path);
				return exported;
			};

			this._gattExports = [
				exportObject(GATT_ROOT, OBJECT_MANAGER_XML, {
					GetManagedObjects: () => ({
						[GATT_SERVICE_PATH]: {
							"org.bluez.GattService1": {
								UUID: new GLib.Variant("s", GATT_SERVICE_UUID),
								Primary: new GLib.Variant("b", true),
							},
						},
						[GATT_CHAR_PATH]: {
							"org.bluez.GattCharacteristic1": {
								UUID: new GLib.Variant("s", GATT_CHAR_UUID),
								Service: new GLib.Variant("o", GATT_SERVICE_PATH),
								Flags: new GLib.Variant("as", ["read"]),
							},
						},
					}),
				}),
				exportObject(GATT_CHAR_PATH, GATT_CHAR_XML, {
					ReadValue: () => new Uint8Array([this._intent]),
				}),
				exportObject(GATT_ADV_PATH, GATT_ADV_XML, {
					Type: "peripheral",
					ServiceUUIDs: [GATT_SERVICE_UUID],
					Release: () => {},
				}),
			];

			await this._bluezAdapterCall(
				"org.bluez.GattManager1",
				"RegisterApplication",
				new GLib.Variant("(oa{sv})", [GATT_ROOT, {}]),
			);
			await this._bluezAdapterCall(
				"org.bluez.LEAdvertisingManager1",
				"RegisterAdvertisement",
				new GLib.Variant("(oa{sv})", [GATT_ADV_PATH, {}]),
			);
		}

		async _unregisterIntent() {
			if (!this._gattExports.length) return;
			const objects = this._gattExports;
			this._gattExports = [];

			await this._bluezAdapterCall(
				"org.bluez.LEAdvertisingManager1",
				"UnregisterAdvertisement",
				new GLib.Variant("(o)", [GATT_ADV_PATH]),
			).catch(() => {});
			await this._bluezAdapterCall(
				"org.bluez.GattManager1",
				"UnregisterApplication",
				new GLib.Variant("(o)", [GATT_ROOT]),
			).catch(() => {});

			objects.forEach((exported) => exported.unexport());
		}

		async _restoreBluetooth() {
			if (!this._wasBluetoothDisabled) return;
			this._wasBluetoothDisabled = false;
			await this._run(["rfkill", "block", "bluetooth"]);
		}

		async _bluezDeviceProxy(devicePath: string): Promise<Gio.DBusProxy> {
			return await new Promise((resolve, reject) => {
				Gio.DBusProxy.new_for_bus(
					Gio.BusType.SYSTEM,
					Gio.DBusProxyFlags.NONE,
					null,
					"org.bluez",
					devicePath,
					"org.bluez.Device1",
					null,
					(src, res) => {
						try {
							resolve(Gio.DBusProxy.new_for_bus_finish(res));
						} catch (e) {
							reject(e);
						}
					},
				);
			});
		}

		async _findBluezDevicePath(btAddress: string): Promise<string | null> {
			// BlueZ device object paths are like /org/bluez/hci0/dev_XX_XX_XX_XX_XX_XX
			const formatted = btAddress.replace(/:/g, "_");
			const manager: Gio.DBusProxy = await new Promise((resolve, reject) => {
				Gio.DBusProxy.new_for_bus(
					Gio.BusType.SYSTEM,
					Gio.DBusProxyFlags.NONE,
					null,
					"org.bluez",
					"/",
					"org.freedesktop.DBus.ObjectManager",
					null,
					(src, res) => {
						try {
							resolve(Gio.DBusProxy.new_for_bus_finish(res));
						} catch (e) {
							reject(e);
						}
					},
				);
			});
			const [objects] = await new Promise<
				[Record<string, Record<string, unknown>>]
			>((resolve, reject) => {
				manager.call(
					"GetManagedObjects",
					null,
					Gio.DBusCallFlags.NONE,
					-1,
					null,
					(proxy, res) => {
						try {
							resolve(
								proxy?.call_finish(res).deep_unpack() as [
									Record<string, Record<string, unknown>>,
								],
							);
						} catch (e) {
							reject(e);
						}
					},
				);
			});

			for (let [path, interfaces] of Object.entries(objects)) {
				if (
					interfaces["org.bluez.Device1"] &&
					path.endsWith(`dev_${formatted}`)
				) {
					return path;
				}
			}
			return null;
		}

		async _bluezSetConnectedState(
			device: Gio.DBusProxy,
			connect: boolean = true,
		) {
			const method = connect ? "ConnectProfile" : "Disconnect";
			// NAP
			const params = connect ? new GLib.Variant("(s)", ["0x1116"]) : null;
			return new Promise((resolve, reject) => {
				device.call(
					method,
					params,
					Gio.DBusCallFlags.NONE,
					-1,
					null,
					(proxy, res) => {
						try {
							proxy?.call_finish(res);
							resolve(undefined);
						} catch (e) {
							if (connect) resolve(undefined);
							else reject(e);
						}
					},
				);
			});
		}

		async _handleWiFi() {
			const ssid = this._settings.get_string("wifi-ssid");
			if (this.quickSettingsItems[0].checked) {
				let attempt = 0,
					connected = false;
				while (!connected && attempt++ < 5) {
					if ((await this._isConnectedToSSID(ssid)).connected) {
						this._showNotification(_("Connected to Wi-Fi network: ") + ssid);
						this._indicator.visible = true;
						return;
					}
					const wifiEnabled = await this._run(["nmcli", "radio", "wifi"]);
					if (wifiEnabled.stdout.includes("disabled")) {
						await this._run(["nmcli", "radio", "wifi", "on"]);
					}
					await this._run(["nmcli", "device", "wifi", "rescan"]);
					const wifiDevices = await this._run([
						"nmcli",
						"device",
						"wifi",
						"list",
					]);
					if (wifiDevices.stdout.includes(ssid)) {
						const result = await this._run([
							"nmcli",
							"device",
							"wifi",
							"connect",
							ssid,
						]);
						connected = !!result?.success;
					}
					if (!connected) await this._wait(5);
				}
				if (connected) {
					this._showNotification(_("Connected to Wi-Fi network: ") + ssid);
					this._indicator.visible = true;
				} else {
					this._showNotification(
						_("Failed to connect to Wi-Fi network: ") + ssid,
					);
					this._indicator.visible = false;
					this.quickSettingsItems[0].checked = false;
				}
			} else {
				if (!(await this._isConnectedToSSID(ssid)).found) {
					this._showNotification(_("Disconnected from Wi-Fi network: ") + ssid);
					this._indicator.visible = false;
					return;
				}
				const { stdout } = await this._run(["nmcli", "device"]);
				const wifiLine = stdout
					.split("\n")
					.find((line) => line.includes("wifi"));
				const wifiDevice = wifiLine ? wifiLine.trim().split(/\s+/)[0] : "wlo1";

				await this._run(["nmcli", "device", "disconnect", wifiDevice]);
				this._showNotification(_("Disconnected from Wi-Fi network: ") + ssid);
				this._indicator.visible = false;
				await this._run(["nmcli", "device", "wifi", "rescan"]);
				await this._run([
					"nmcli",
					"device",
					"set",
					wifiDevice,
					"autoconnect",
					"on",
				]);
			}
		}
		destroy() {
			this.quickSettingsItems?.forEach((i) => {
				i.destroy();
			});
			if (this._timerid) {
				GLib.Source.remove(this._timerid);
				this._timerid = 0;
			}
			this._unregisterIntent();
			this._indicator.destroy();
			super.destroy();
		}
	},
);

// The main extension class
export default class HotspotExtension extends Extension {
	settings!: Gio.Settings | null;
	indicator!: InstanceType<typeof HotspotToggle> | null;

	enable() {
		// Get the settings for this extension
		this.settings = this.getSettings(
			"org.gnome.shell.extensions.hotspot-toggle",
		);

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
