# Hotspot Toggle (GNOME Shell Extension)

Toggle your Android phone's hotspot from the GNOME Shell Quick Settings menu!

> Status: Proof-of-concept. If you have issues, open a GitHub issue and I'll try and get on it!

## Requirements

- GNOME Shell 45–48 (haven't tested it with any version outside of GNOME 48 though)
- NetworkManager with `nmcli`
- An Android device with [Automate flow](https://llamalab.com/automate/community/flows/50803) downloaded (https://llamalab.com/automate/community/flows/50803)

## Installation

Install through (GNOME Extensions)[https://extensions.gnome.org/extension/8508/hotspot-toggle/] (https://extensions.gnome.org/extension/8508/hotspot-toggle/)

To install manually, clone the repo, `cd` into the directory and run `make install`.

## Usage

1. Ensure your machine and your phone are paired via Bluetooth and that the hotspot is configured on your machine (password entered, etc.)
2. In the Automate app, set the bluetooth device to your machine
3. Start the flow
4. In the settings window of the extension, enter the Bluetooth MAC address of your Android device and the SSID of your device's hotspot.
5. Profit!
