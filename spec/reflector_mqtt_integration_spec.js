// Integration test against a REAL running MQTT broker (mqtt://localhost:1883 by default).
// Exercises the full loop: renderer -> IPC -> reflector -> env.publish -> broker -> env
// delivery -> reflector.handler_MsgEnv -> window.webContents.send. Also confirms the
// per-instance wire() actually unions the real v3 MsgEnv logger.
//
// Requires @ipsme/msgenv-mqtt installed AND a broker up on mqtt://localhost:1883.
//
// Gating is in two parts, because "the package is installed" does NOT imply "a broker is
// running" -- and on darwin the MQTT package is installed anyway (it carries no `os`
// restriction) even though NSDNC is that platform's default env:
//   1. package not loadable  -> the whole suite is xdescribe'd (skipped outright);
//   2. package loads but no broker answers on :1883 -> the round-trip specs pend() themselves.
// Either way the suite passes on macOS and Windows without a manually-provisioned broker, while
// still fully exercising the real loop when one is up.

const net = require('net');

let IPSME_MsgEnv;
try {
	IPSME_MsgEnv = require('@ipsme/msgenv-mqtt');
} catch (e) {
	IPSME_MsgEnv = null;
}

const { Reflector_IPC_main } = require('../dist/reflector-ipc-main.cjs.js');

// TCP-probe the broker port rather than assume it is up. Resolves true only on a completed
// connection; any error/timeout resolves false (suite pends instead of failing).
function broker_reachable(host, port, timeout_ms) {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		let settled = false;
		const done = (up) => { if (settled) return; settled = true; sock.destroy(); resolve(up); };
		sock.setTimeout(timeout_ms);
		sock.once('connect', () => done(true));
		sock.once('timeout', () => done(false));
		sock.once('error', () => done(false));
	});
}

(IPSME_MsgEnv ? describe : xdescribe)('Reflector_IPC_main <-> real MQTT', () => {
	let reflector, received, ipc_handlers, broker_up;
	const DEFAULT_TIMEOUT = 15000;
	let saved_timeout;

	beforeAll(async () => {
		saved_timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
		jasmine.DEFAULT_TIMEOUT_INTERVAL = DEFAULT_TIMEOUT;

		broker_up = await broker_reachable('localhost', 1883, 1000);

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
		if (! broker_up) { pending('no MQTT broker on mqtt://localhost:1883'); return; }
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
		if (! broker_up) { pending('no MQTT broker on mqtt://localhost:1883'); return; }
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
