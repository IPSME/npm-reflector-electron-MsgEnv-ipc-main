
const { LOGR, l_array } = require('@knev/bitlogr');

// MQTT is cross-platform, so -- unlike the NSDNC reflector -- there is no per-OS
// branch here; the MQTT messaging environment is always the one we reflect to/from.
const IPSME_MsgEnv_OS = require('@ipsme/msgenv-mqtt');

const { MsgCache, MsgContext } = require('@ipsme/msgcache-dedup');

const knr_MSG_EXPIRATION_ms= 20000;

//-------------------------------------------------------------------------------------------------

const LOGR_= LOGR.get_instance();

// '@ipsme/msgenv-mqtt' shares this same (global) LOGR instance and occupies bits
// CONNECTIONS= 0b1<<0 and REFLECTION= 0b1<<1. We start our own labels above those
// so the reflector can be toggled independently of the messaging environment.
const logr_= LOGR_.create({ labels: l_array(['Reflector_IPC_main', 'DUPS', 'CXNS', 'REFL'], 0b1 << 2) });
const l_= logr_.l;

//-------------------------------------------------------------------------------------------------

class Reflector_IPC_main {
	constructor(ipcMain) {
		this._msgcache= new MsgCache();
		this._ipcMain= ipcMain;
		this._windows= new Set();
	}

	// -----

	//TODO: handlers should be private

	handler_MQTT(msg)
	{
		try {
			logr_.log(l_.REFL, () => ['electron: REFL: mqtt -> ipc -- ', msg]);

			this._msgcache.cache(msg, new MsgContext(knr_MSG_EXPIRATION_ms));

			this._windows.forEach(window => {
				console.assert(! (!window || window.isDestroyed()), "invalid window handle; was not properly removed on close?");
				if (! window || window.isDestroyed()) {
					return;
				}
				window.webContents.send('ipc-reflector-to-window', msg);
			});
		}
		catch(e) {
			console.log('Unhandled exception:', e);
		}
	}

	handler_ipc(event, msg)
	{
		let [ b_res, ctx ]= this._msgcache.contains(msg)
		if (b_res) {
			logr_.log(l_.DUPS, () => ['App: REFL: *DUP | <- ipc -- ', msg]);
			return;
		}

		logr_.log(l_.REFL, () => ['electron: REFL: mqtt <- ipc -- ', msg]);

		IPSME_MsgEnv_OS.publish(msg);
	};

	// -----

	subscribe() {
		// https://javascript.plainenglish.io/messaging-between-electron-windows-a646b0af7d8d
		this._ipcMain.on('ipc-reflector-to-main', this.handler_ipc.bind(this) );

		logr_.log(l_.CXNS, () => ['electron: REFL: subscribe']);
		IPSME_MsgEnv_OS.subscribe( this.handler_MQTT.bind(this) );
	}

	add_window(win) {
		this._windows.add(win);
	}

	remove_window(win) {
		this._windows.delete(win);
	}

	static set options(obj) {
		this._options= obj;
		IPSME_MsgEnv_OS.config.options= this._options;
		if (this._options.logr)
			LOGR_.toggle(l_, this._options.logr);
	}
}

//-------------------------------------------------------------------------------------------------

module.exports.Reflector_IPC_main= Reflector_IPC_main;
module.exports.l= l_;
