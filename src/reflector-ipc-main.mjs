
import { LOGR, l_array } from '@knev/bitlogr';
import { MsgCache, MsgContext, logr as logr_mc_ } from '@ipsme/msgcache-dedup';

// MQTT is cross-platform, so -- unlike the NSDNC reflector -- there is no per-OS
// branch here; the MQTT messaging environment is always the one we reflect to/from.
const IPSME_MsgEnv_OS = require('@ipsme/msgenv-mqtt');


const knr_MSG_EXPIRATION_ms= 20000;

//-------------------------------------------------------------------------------------------------

const LOGR_= LOGR.get_instance();

// The reflector's own logger. It is wired to the *configured* MsgEnv's logger per-instance in
// the constructor -- not here -- because at module load there is no configured env whose labels
// we could union with (the env is injected or OS-resolved only at construction).
const logr_self_ = LOGR_.create({ name: "Reflector_IPC_main", labels: l_array(['DUPLICATES', 'CONNECTIONS', 'REFLECTION']) });
// ** see constructor() for wire()

//-------------------------------------------------------------------------------------------------

class Reflector_IPC_main {
	constructor(ipcMain) {
		this._msgcache= new MsgCache();
		this._ipcMain= ipcMain;
		this._windows= new Set();

		// Wire the reflector's own logger together with the loggers of the participants it uses --
		// the dedup cache and the *configured* MsgEnv -- so all their label sets share one toggle
		// mask. Per-instance because the MsgEnv is only known now (injected or OS-resolved).
		// Feature-detect each: only a participant exposing a v3 logr (has .lref) is wireable; a
		// legacy build (bitlogr 0.2.x -- e.g. msgcache-dedup <=0.1.16 exports no `logr`) is simply
		// left to log on its own.
		const arr_logr= [ logr_self_ ];
		if (logr_mc_ && typeof logr_mc_.lref?.get === 'function')
			arr_logr.push(logr_mc_);
		if (msgEnv.logr && typeof msgEnv.logr.lref?.get === 'function')
			arr_logr.push(msgEnv.logr);
		this._logr= LOGR_.wire(arr_logr);
		this._l= this._logr.l;
	}

	// -----

	//TODO: handlers should be private

	handler_MQTT(msg)
	{
		try {
			this._logr.log(this._l.REFLECTION, () => ['msgenv -> ipc -- ', msg]);

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
			this._logr.log(this._l.DUPLICATES, () => ['*DUP | <- ipc -- ', msg]);
			return;
		}

		this._logr.log(this._l.REFLECTION, () => ['msgenv <- ipc -- ', msg]);

		IPSME_MsgEnv_OS.publish(msg);
	};

	// -----

	subscribe() {
		// https://javascript.plainenglish.io/messaging-between-electron-windows-a646b0af7d8d
		this._ipcMain.on('ipc-reflector-to-main', this.handler_ipc.bind(this) );

		IPSME_MsgEnv_OS.subscribe( this.handler_MQTT.bind(this) );
		this._logr.log(this._l.CONNECTIONS, () => ['subscribe']);
	}

	add_window(win) {
		this._windows.add(win);
	}

	remove_window(win) {
		this._windows.delete(win);
	}

	set options(obj) {
		this._options= obj;
	}
}

//-------------------------------------------------------------------------------------------------

export { Reflector_IPC_main, logr_self_ as logr };
