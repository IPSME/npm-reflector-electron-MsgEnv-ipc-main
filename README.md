# npm-reflector-electron-MQTT-ipc-main

A reflector between an **MQTT** messaging environment and **Electron IPC** (main process).
Messages published to MQTT (topic `IPSME`) are forwarded to every registered renderer
window, and messages sent from a renderer are published back to MQTT. Duplicate
reflections are suppressed via [`@ipsme/msgcache-dedup`](https://github.com/IPSME/npm-msgcache-dedup).

The MQTT connection itself is provided by [`@ipsme/msgenv-mqtt`](https://github.com/IPSME/npm-msgenv-MQTT)
(broker `mqtt://localhost:1883` by default).

> ### IPSME — Idempotent Publish/Subscribe Messaging Environment
> https://dl.acm.org/doi/abs/10.1145/3458307.3460966

```
main.js | electron.js
```

```js
//-------------------------------------------------------------------------------------------------
// reflector mqtt <-> ipc

const { Reflector_IPC_main } = require('@ipsme/reflector-electron-mqtt-ipc-main');
const { ipcMain } = require('electron');

const reflector_IPC_main_ = new Reflector_IPC_main(ipcMain);
reflector_IPC_main_.subscribe();

//-------------------------------------------------------------------------------------------------

function createWindow() {
	// Create the browser window.
	const win = new BrowserWindow({
		// ...
		webPreferences: {
			// nodeIntegration: true,
			preload: __dirname + '/preload.js'
		},
	});

	// ...

	reflector_IPC_main_.add_window(win);

	win.on('closed', () => {
		reflector_IPC_main_.remove_window(win);
		// ...
	});
}
```

```js
//-------------------------------------------------------------------------------------------------
// preload.js

// https://github.com/electron/electron/issues/9920#issuecomment-947170941

const { contextBridge, ipcRenderer } = require("electron");

// As an example, here we use the exposeInMainWorld API to expose the IPC renderer
// to the main window. They'll be accessible at "window.ipc_reflector".
process.once("loaded", () => {
    contextBridge.exposeInMainWorld('ipc_reflector',
		{
			// https://github.com/electron/electron/issues/21437#issuecomment-573522360
			send: (msg) => ipcRenderer.send('ipc-reflector-to-main', msg),
			recv: (fn) => {
				// Deliberately strip event as it includes `sender`
				ipcRenderer.on('ipc-reflector-to-window', (event, ...args) => fn(...args));
			}
		}
	);
});
```

## Logging

Logging uses [`@knev/bitlogr`](https://github.com/knev/npm-bitlogr) (3.x). The reflector's
labels (`Reflector_IPC_main`, `DUPS`, `CXNS`, `REFL`) start above the bits used by
`@ipsme/msgenv-mqtt` (`CONNECTIONS`, `REFLECTION`) on the shared `LOGR` instance, so they
can be toggled independently:

```js
Reflector_IPC_main.options = { logr: { REFL: true, CXNS: true } };
```

`options` is also forwarded to the MQTT messaging environment's `config` (e.g. `channel`, `prefix`).
