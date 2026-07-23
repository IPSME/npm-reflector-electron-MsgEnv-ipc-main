// Integration test against a REAL running MQTT broker (mqtt://localhost:1883 by default).
// Exercises the full loop: renderer -> IPC -> reflector -> env.publish -> broker -> env
// delivery -> reflector.handler_MsgEnv -> window.webContents.send. Also confirms the
// per-instance wire() actually unions the real v3 MsgEnv logger.
//
// Requires @ipsme/msgenv-mqtt installed and a broker up. If the env can't be loaded the whole
// suite is marked pending (so the unit specs still pass on a machine without it).

let IPSME_MsgEnv;
try {
	IPSME_MsgEnv = require('@ipsme/msgenv-mqtt');
} catch (e) {
	IPSME_MsgEnv = null;
}

const { Reflector_IPC_main } = require('../dist/reflector-ipc-main.cjs.js');

(IPSME_MsgEnv ? describe : xdescribe)('Reflector_IPC_main <-> real MQTT', () => {
	let reflector, received, ipc_handlers;
	const DEFAULT_TIMEOUT = 15000;
	let saved_timeout;

	beforeAll(() => {
		saved_timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
		jasmine.DEFAULT_TIMEOUT_INTERVAL = DEFAULT_TIMEOUT;

		received = [];
		ipc_handlers = {};
		const ipcMain = { on: (channel, fn) => { ipc_handlers[channel] = fn; } };

		// inject the real MQTT messaging environment
		reflector = new Reflector_IPC_main(ipcMain, IPSME_MsgEnv);
		reflector.add_window({
			isDestroyed: () => false,
			webContents: { send: (_channel, m) => received.push(m) }
		});
		reflector.subscribe();
	});

	afterAll((done) => {
		jasmine.DEFAULT_TIMEOUT_INTERVAL = saved_timeout;
		try { if (typeof IPSME_MsgEnv.dispose === 'function') IPSME_MsgEnv.dispose(); } catch (e) { /* ignore */ }
		// give the client a moment to close its socket before jasmine tears down
		setTimeout(done, 300);
	});

	it('wired the real v3 MsgEnv logger into the reflector mask', () => {
		// the reflector's own labels must be present...
		expect(reflector._l.REFLECTION).toBeGreaterThan(0);
		// ...and the wire must not have collapsed them (sanity on the union)
		expect(reflector._l.DUPLICATES).toBeGreaterThan(0);
		expect(reflector._l.CONNECTIONS).toBeGreaterThan(0);
	});

	it('round-trips a renderer message through the broker to the window', (done) => {
		const msg = JSON.stringify({ id: 'it-' + Date.now(), hello: 'world' });

		// simulate a renderer sending over IPC (the handler registered by subscribe())
		ipc_handlers['ipc-reflector-to-main'](null, msg);

		const t0 = Date.now();
		const poll = setInterval(() => {
			if (received.indexOf(msg) !== -1) {
				clearInterval(poll);
				expect(received).toContain(msg);
				done();
			} else if (Date.now() - t0 > DEFAULT_TIMEOUT - 2000) {
				clearInterval(poll);
				done.fail('window never received the message -- is a broker running on mqtt://localhost:1883?');
			}
		}, 50);
	});

	it('suppresses a renderer echo of a message just delivered from the broker', (done) => {
		const msg = JSON.stringify({ id: 'echo-' + Date.now(), hello: 'again' });

		// first: renderer publishes it; wait until it comes back from the broker (now cached)
		ipc_handlers['ipc-reflector-to-main'](null, msg);

		const t0 = Date.now();
		const wait_delivered = setInterval(() => {
			if (received.indexOf(msg) !== -1) {
				clearInterval(wait_delivered);
				// now the renderer echoes the same message -> dedup must drop it (no re-publish,
				// so no second delivery). Count current deliveries and ensure it doesn't grow.
				const count_before = received.filter((m) => m === msg).length;
				ipc_handlers['ipc-reflector-to-main'](null, msg);
				setTimeout(() => {
					const count_after = received.filter((m) => m === msg).length;
					expect(count_after).toBe(count_before);
					done();
				}, 800);
			} else if (Date.now() - t0 > DEFAULT_TIMEOUT - 2000) {
				clearInterval(wait_delivered);
				done.fail('window never received the seed message -- broker up?');
			}
		}, 50);
	});
});
