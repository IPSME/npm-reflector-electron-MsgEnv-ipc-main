'use strict';

var bitlogr = require('@knev/bitlogr');
var msgcacheDedup = require('@ipsme/msgcache-dedup');

const knr_MSG_EXPIRATION_ms= 20000;

//-------------------------------------------------------------------------------------------------

// The platform-default messaging environment. Resolved lazily, and only when the caller does
// NOT inject one -- it cannot be a static `import` because the two msgenv packages are per-OS
// optionalDependencies (only one is ever installed on a given machine, so importing both
// unconditionally would throw). This bundle targets Electron *main* (CommonJS), so a runtime
// `require` here is the correct synchronous conditional load.
function default_MsgEnv() {
	if (process.platform === 'win32')
		return require('@ipsme/msgenv-mqtt');
	if (process.platform === 'darwin')
		return require('@ipsme/msgenv-electron-nsdnc');
	throw new Error(`reflector-ipc-main: no default messaging environment for platform '${process.platform}'; inject one into the constructor.`);
}

//-------------------------------------------------------------------------------------------------

const LOGR_= bitlogr.LOGR.get_instance();

// The reflector's own logger. It is wired to the *configured* MsgEnv's logger per-instance in
// the constructor -- not here -- because at module load there is no configured env whose labels
// we could union with (the env is injected or OS-resolved only at construction).
const logr_self_ = LOGR_.create({ name: "Reflector_IPC_main", labels: bitlogr.l_array(['DUPLICATES', 'CONNECTIONS', 'REFLECTION']) });
// ** see constructor() for wire()

//-------------------------------------------------------------------------------------------------

class Reflector_IPC_main {
	// msgEnv defaults to the platform messaging environment (MQTT on win32, NSDNC on darwin);
	// inject one to override -- e.g. tests, or selecting a non-default ME. An injected env just
	// needs to expose .publish() / .subscribe().
	constructor(ipcMain, msgEnv= default_MsgEnv()) {
		// Fail loud on a provided-but-unusable env (e.g. an explicit null, or a mock missing
		// part of the contract) rather than deferring to a cryptic later dereference. The
		// default parameter above only covers an *omitted* argument -- null is not undefined.
		if (! msgEnv || typeof msgEnv.publish !== 'function' || typeof msgEnv.subscribe !== 'function')
			throw new Error('Reflector_IPC_main: msgEnv must expose .publish(msg) and .subscribe(handler)');

		this._msgcache= new msgcacheDedup.MsgCache();
		this._ipcMain= ipcMain;
		this._windows= new Set();
		this._msgEnv= msgEnv;

		// Wire the reflector's own logger together with the loggers of the participants it uses --
		// the dedup cache and the *configured* MsgEnv -- so all their label sets share one toggle
		// mask. Per-instance because the MsgEnv is only known now (injected or OS-resolved).
		// Feature-detect each: only a participant exposing a v3 logr (has .lref) is wireable; a
		// legacy build (bitlogr 0.2.x -- e.g. msgcache-dedup <=0.1.16 exports no `logr`) is simply
		// left to log on its own.
		const arr_logr= [ logr_self_ ];
		if (msgcacheDedup.logr && typeof msgcacheDedup.logr.lref?.get === 'function')
			arr_logr.push(msgcacheDedup.logr);
		if (msgEnv.logr && typeof msgEnv.logr.lref?.get === 'function')
			arr_logr.push(msgEnv.logr);
		this._logr= LOGR_.wire(arr_logr);
		this._l= this._logr.l;
	}

	// -----

	//TODO: handlers should be private

	handler_MsgEnv(msg)
	{
		try {
			this._logr.log(this._l.REFLECTION, () => ['msgenv -> ipc -- ', msg]);

			this._msgcache.cache(msg, new msgcacheDedup.MsgContext(knr_MSG_EXPIRATION_ms));

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
		let [ b_res, ctx ]= this._msgcache.contains(msg);
		if (b_res) {
			this._logr.log(this._l.DUPLICATES, () => ['*DUP | <- ipc -- ', msg]);
			return;
		}

		this._logr.log(this._l.REFLECTION, () => ['msgenv <- ipc -- ', msg]);

		this._msgEnv.publish(msg);
	};

	// -----

	subscribe() {
		// https://javascript.plainenglish.io/messaging-between-electron-windows-a646b0af7d8d
		this._ipcMain.on('ipc-reflector-to-main', this.handler_ipc.bind(this) );

		this._logr.log(this._l.CONNECTIONS, () => ['subscribe']);
		this._msgEnv.subscribe( this.handler_MsgEnv.bind(this) );
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

exports.Reflector_IPC_main = Reflector_IPC_main;
exports.logr = logr_self_;
