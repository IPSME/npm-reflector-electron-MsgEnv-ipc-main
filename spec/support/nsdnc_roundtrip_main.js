// Electron MAIN-process entry that performs REAL NSDNC round-trips through the reflector and
// prints a single `RESULT:<json>` line to stdout, then exits. It is NOT a jasmine file (its name
// doesn't match the spec glob); it is spawned via the electron binary by
// reflector_nsdnc_integration_spec.js. macOS-only -- NSDistributedNotificationCenter lives in
// Electron's main process on darwin and has no headless/node equivalent, which is why this can't
// run inside plain jasmine the way the MQTT integration spec does.
//
// Exercises the same loop the MQTT spec does, but over NSDNC:
//   renderer -> IPC -> reflector.handler_ipc -> env.publish (postNotification)
//     -> NSDNC delivery -> env.subscribe cb -> reflector.handler_MsgEnv -> window.webContents.send
// plus the dedup guard (a renderer echo of a message just delivered from the ME must not
// re-publish).

const { app } = require('electron');

// Resolve the reflector bundle relative to this file, and the NSDNC env by package name (the
// reflector's node_modules is the resolution root). NSDNC pulls in `electron` at load, so it can
// only be required here, inside a real Electron main process.
const { Reflector_IPC_main } = require('../../dist/reflector-ipc-main.cjs.js');
const IPSME_MsgEnv = require('@ipsme/msgenv-electron-nsdnc');

const PHASE_TIMEOUT = 8000;

function emit(obj) { process.stdout.write('RESULT:' + JSON.stringify(obj) + '\n'); }

// Poll `received` until `msg` shows up (resolve true) or the timeout elapses (resolve false).
function wait_for(received, msg, timeout_ms) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const poll = setInterval(() => {
			if (received.indexOf(msg) !== -1) { clearInterval(poll); resolve(true); }
			else if (Date.now() - t0 > timeout_ms) { clearInterval(poll); resolve(false); }
		}, 25);
	});
}

app.whenReady().then(async () => {
	try {
		const received = [];
		const ipc_handlers = {};
		const ipcMain = { on: (channel, fn) => { ipc_handlers[channel] = fn; } };

		// inject the real NSDNC messaging environment
		const reflector = new Reflector_IPC_main(ipcMain, IPSME_MsgEnv);
		reflector.add_window({
			isDestroyed: () => false,
			webContents: { send: (_channel, m) => received.push(m) }
		});
		reflector.subscribe();

		const send_ipc = (m) => ipc_handlers['ipc-reflector-to-main'](null, m);

		// --- round-trip: a renderer message must come back to the window via NSDNC
		const rt_msg = JSON.stringify({ id: 'nsdnc-rt-' + process.pid, hello: 'world' });
		send_ipc(rt_msg);
		const rt_ok = await wait_for(received, rt_msg, PHASE_TIMEOUT);

		// --- dedup: with `rt_msg` now delivered-from-ME (and cached), a renderer echo of it must
		// not be re-published -> no second delivery. Count copies before/after the echo.
		let dedup = { ok: false, before: null, after: null };
		if (rt_ok) {
			const before = received.filter((m) => m === rt_msg).length;
			send_ipc(rt_msg);                                   // echo the just-delivered message
			await new Promise((r) => setTimeout(r, 800));       // give any (wrong) re-delivery time
			const after = received.filter((m) => m === rt_msg).length;
			dedup = { ok: after === before, before, after };
		}

		emit({ roundtrip: { ok: rt_ok, msg: rt_msg }, dedup });
		app.exit(rt_ok && dedup.ok ? 0 : 2);
	}
	catch (e) {
		emit({ error: String((e && e.stack) || e) });
		app.exit(3);
	}
});
