# Hotspot Toggle (GNOME Shell Extension)

Toggle your Android phone's hotspot from the GNOME Shell Quick Settings menu!

> Status: Early version / proof-of-concept. If you have issues, open a GitHub issue and I'll try and get on it!

## Requirements

- GNOME Shell 45–48 (haven't tested it with any version outside of GNOME 48 though)
- BlueZ
- NetworkManager with `nmcli`
- An Android device with [Automate flow](https://llamalab.com/automate/community/flows/50803) configured

## Usage

1. Ensure your machine and your phone are paired via Bluetooth and that the hotspot is configured on your machine (password entered, etc.)
2. In the Automate app, set the bluetooth device to your machine
3. Start the flow
4. In the settings window of the extension, enter the Bluetooth MAC address of your Android device and the SSID of your device's hotspot.
5. Profit!
