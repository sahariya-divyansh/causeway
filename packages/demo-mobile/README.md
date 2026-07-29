# Causeway Demo Mobile App (Expo / React Native)

This package contains an Expo-based React Native mobile application integrating Causeway's sync client. It demonstrates synchronization using an asynchronous `expo-sqlite` storage adapter.

## Prerequisites

1. **Node.js** >= 24
2. **Expo Go** app installed on your physical mobile device (available on App Store and Google Play).
3. **Local WiFi Connection**: Both your PC running the relay server and your mobile device **MUST** be connected to the exact same local WiFi network.

---

## Step-by-Step Test Guide

### 1. Start the Relay Server on your PC
From the project workspace root, run the relay server:
```bash
npm run dev -w @causeway-sync/relay-server
```
The server will start at `http://localhost:3000` (locally on your PC).

### 2. Find your PC's LAN IP Address
A phone running Expo Go cannot resolve `localhost` or `127.0.0.1` to mean your PC. You need the PC's actual local area network (LAN) IP.

* **On Windows**: Open PowerShell or Cmd and run:
  ```cmd
  ipconfig
  ```
  Look for the IPv4 Address under your active connection (e.g., `Wireless LAN adapter Wi-Fi` or `Ethernet adapter`). It usually looks like `192.168.x.x` (e.g., `192.168.1.100`).
* **On macOS/Linux**: Run `ifconfig` or `ip a` to find your local IP address.

### 3. Start the Expo Dev Server
From the workspace root, start the Expo bundler:
```bash
npx expo start --workspace=demo-mobile
```
This launches Metro Bundler and outputs a QR code in the terminal.

### 4. Load the App on your Device
* Open the **Expo Go** app on your phone.
* **Android**: Scan the terminal's QR code using the "Scan QR Code" button in Expo Go.
* **iOS**: Scan the terminal's QR code using the system Camera app, then tap the link to open in Expo Go.

---

## Testing Sync Between Two Sessions

To test synchronization, you need two sessions. This can be:
- Two physical mobile devices running Expo Go.
- One physical device and one Simulator (iOS Simulator / Android Emulator).
- One physical device and one web session (press `w` in the Expo start terminal to load in the browser).

### Step-by-Step Sync Flow:

1. **Configure Relay Server URL**:
   On both sessions, update the **Relay Server URL** field at the top to use your PC's LAN IP (e.g., `http://192.168.1.100:3000`).

2. **Select Roles**:
   - **Device 1**: Tap **Role A** (Upload Session: `session-mobile-A`, Download Session: `session-mobile-B`).
   - **Device 2**: Tap **Role B** (Upload Session: `session-mobile-B`, Download Session: `session-mobile-A`).

3. **Add Items**:
   - On **Device 1**, type `Buy milk` and tap **Add**.
   - On **Device 2**, type `Call doctor` and tap **Add**.

4. **Synchronize**:
   * Tap **Sync Now** on **Device 1**.
     * Status updates: `Syncing...` &rarr; `Synced`.
     * (Device 1 has now uploaded its local changes to `session-mobile-A`).
   * Tap **Sync Now** on **Device 2**.
     * Status updates: `Syncing...` &rarr; `Synced`.
     * (Device 2 downloads the changes from `session-mobile-A`, merges `Buy milk` locally, and uploads its own combined state to `session-mobile-B`).
     * **Device 2 now displays both items**: `Buy milk` and `Call doctor`.
   * Tap **Sync Now** on **Device 1** again.
     * (Device 1 downloads the changes from `session-mobile-B` and merges them).
     * **Device 1 now displays both items**: `Buy milk` and `Call doctor`.

Both sessions have converged! You can toggle checks or add more items and repeat the sync flow to see real-time local-first resolution in action.
