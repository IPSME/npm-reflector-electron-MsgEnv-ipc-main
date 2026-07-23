# npm-reflector-electron-MsgEnv-ipc-main

A reflector between a **messaging environment** and **Electron IPC** (main process).
Messages published to the messaging environment are forwarded to every registered renderer
window, and messages sent from a renderer are published back to it. Duplicate reflections are
suppressed via [`@ipsme/msgcache-dedup`](https://github.com/IPSME/npm-msgcache-dedup).

The messaging environment is chosen per platform by default:

| Platform          | Default messaging environment                                                        |
|-------------------|--------------------------------------------------------------------------------------|
| `win32`           | [`@ipsme/msgenv-mqtt`](https://github.com/IPSME/npm-msgenv-MQTT) (`mqtt://localhost:1883`) |
| `darwin`          | [`@ipsme/msgenv-electron-nsdnc`](https://github.com/IPSME/npm-msgenv-NSDNC) (NSDistributedNotificationCenter) |
| anything else     | none — you must inject one (see *Overriding the default* below)                       |

Both msgenv packages are `optionalDependencies`, and only the one for your platform is ever
`require`d at runtime -- `default_MsgEnv()` loads MQTT on `win32`, NSDNC on `darwin`. So the app
runs with just the platform's package present, and if you inject your own (see *Overriding the
default* below) you need neither.

> **Note:** `optionalDependencies` does *not* make npm install only the platform's package. It
> means "don't fail the whole install if one of these can't be installed" -- npm skips an optional
> dep only when it actually *fails* (e.g. an `os`/`cpu` mismatch or a build error). Neither
> `msgenv-*` package declares an `os` field, so **a default `npm install` installs both on every
> platform**; the per-platform choice happens purely at runtime in `default_MsgEnv()`. If you want
> npm to prune the wrong one automatically, those packages would each need an `os` field (`darwin`
> on NSDNC, `win32` on MQTT) -- nothing in this repo can enforce that. In the meantime you can
> remove the unused one yourself, or just leave it (harmless, only ever `require`d on its platform).

> ### IPSME — Idempotent Publish/Subscribe Messaging Environment
> https://dl.acm.org/doi/abs/10.1145/3458307.3460966

```
main.js | electron.js
```

```js
//-------------------------------------------------------------------------------------------------
// reflector msgenv <-> ipc

const { Reflector_IPC_main } = require('@ipsme/reflector-electron-msgenv-ipc-main');
const { ipcMain } = require('electron');

// No second argument -> uses the platform default (MQTT on win32, NSDNC on darwin).
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

## Overriding the default messaging environment

Pass a messaging environment as the **second constructor argument** and it is used instead of the
platform default (which is then never resolved -- so you don't even need the platform's `msgenv-*`
package installed). This is how you run on an unsupported platform, select a non-default ME, or
inject a mock/stub in tests.

The injected object must expose:

- **`publish(msg)`** -- publish a message to the ME;
- **`subscribe(handler)`** -- register `handler(msg)` for messages arriving from the ME;
- *(optional)* **`logr`** -- a bitlogr-3.x logger; if present it is wired into the reflector's
  logging (see *Logging* below).

A provided-but-unusable env (missing `publish`/`subscribe`, or an explicit `null`) throws at
construction: `Reflector_IPC_main: msgEnv must expose .publish(msg) and .subscribe(handler)`.

```js
const { Reflector_IPC_main } = require('@ipsme/reflector-electron-msgenv-ipc-main');
const IPSME_MsgEnv = require('@ipsme/msgenv-mqtt'); // or any ME you like

const reflector_IPC_main_ = new Reflector_IPC_main(ipcMain, IPSME_MsgEnv);
reflector_IPC_main_.subscribe();
```

A stub is enough for tests -- no broker required:

```js
const bus = [];
const fake_env = {
	publish:   (msg) => bus.push(msg),
	// keep the handler so a test can push an inbound ME message: fake_env.deliver(msg)
	subscribe: (handler) => { fake_env.deliver = handler; }
};
const reflector_IPC_main_ = new Reflector_IPC_main(ipcMain, fake_env);
```

## Preload (context bridge)

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

Logging uses [`@knev/bitlogr`](https://github.com/knev/npm-bitlogr) (3.x). On construction the
reflector `wire()`s its own logger (labels `DUPLICATES`, `CONNECTIONS`, `REFLECTION`) together
with the loggers of the participants it uses -- the
[`@ipsme/msgcache-dedup`](https://github.com/IPSME/npm-msgcache-dedup) dedup cache and the
configured messaging environment -- so every label shares one toggle mask on the shared `LOGR`
instance. Only a participant exposing a bitlogr-3.x logger (one with a `.lref`) is wired; a
legacy build is simply left to log on its own.

The wired logger is exported as `logr`. Toggle categories through the shared `LOGR` instance,
after a reflector has been constructed (construction is when the wire happens):

```js
const { logr } = require('@ipsme/reflector-electron-msgenv-ipc-main');
const { LOGR } = require('@knev/bitlogr');

LOGR.get_instance().toggle(logr.l, { REFLECTION: true, CONNECTIONS: true });
```

> **Note:** `options` is currently an inert instance setter -- it stores the value but does not
> (yet) toggle logging or forward to the messaging environment's `config`.
